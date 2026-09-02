import { expect, test } from "@playwright/test";
import { agentInput, api, APP_URL, AUTH_URL, gotoPath, initialPassword, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

const unique = () => Math.random().toString(36).slice(2, 8);

test.describe("认证", () => {
  test("登录、浏览并退出", async ({ page }) => {
    await page.goto(AUTH_URL);
    await expect(page.getByLabel("访问密码")).toBeVisible();

    // Wrong password stays on the form with the server error message
    // (only on one project to respect the login rate limit).
    if (test.info().project.name === "chromium") {
      await page.getByLabel("访问密码").fill("00000000");
      await page.getByRole("button", { name: "登录" }).click();
      await expect(page.getByRole("alert")).toContainText("密码错误");
    }

    await page.getByLabel("访问密码").fill(initialPassword());
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".app-frame")).toBeVisible();

    await page.goto(`${AUTH_URL}/settings/security`);
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByLabel("访问密码")).toBeVisible();
  });
});

test.describe("应用外壳", () => {
  test("主导航在各区域间切换，深链接可直接打开", async ({ page }) => {
    await page.goto(APP_URL);
    await openDrawerIfNeeded(page);
    await expect(page.locator(".sidebar-brand")).toHaveText(/llm-chat/);

    await gotoPath(page, "/agents");
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();

    await gotoPath(page, "/tasks");
    await expect(page.getByRole("heading", { name: "后台任务" })).toBeVisible();
    await expect(page.getByText("没有后台任务")).toBeVisible();

    await gotoPath(page, "/settings/general");
    await expect(page.getByLabel("主题")).toBeVisible();

    // Direct deep link into the SPA, served by the history fallback.
    await page.goto(`${APP_URL}/settings/memories`);
    await expect(page.getByRole("heading", { name: "长期记忆" })).toBeVisible();
  });

  test("主题切换持久化到服务端设置", async ({ page, request }) => {
    await gotoPath(page, "/settings/general");
    const before = (await api(request, APP_URL, "GET", "/api/settings")).theme;
    const next = before === "dark" ? "light" : "dark";
    try {
      await page.getByLabel("主题").selectOption(next);
      await expect
        .poll(async () => (await api(request, APP_URL, "GET", "/api/settings")).theme)
        .toBe(next);
      await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    } finally {
      await api(request, APP_URL, "PATCH", "/api/settings", { theme: before });
    }
  });

  test("PWA 资源可访问且 API 不被缓存", async ({ page }) => {
    await page.goto(APP_URL);
    const documentResponse = await page.request.get(APP_URL);
    const html = await documentResponse.text();
    const scriptPath = html.match(/<script[^>]+src="([^"]*\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
    expect(scriptPath).toBeTruthy();
    const script = await page.request.get(`${APP_URL}${scriptPath}`);
    expect(script.ok()).toBeTruthy();
    expect(script.headers()["content-type"]).toMatch(/(?:application|text)\/javascript/);
    const stale = await page.request.get(`${APP_URL}/assets/index-stale-e2e.js`);
    expect(stale.status()).toBe(404);
    expect(stale.headers()["content-type"]).toContain("text/plain");
    expect(await stale.text()).toBe("Asset not found");
    expect(await page.locator("script:not([src])").count()).toBe(0);

    const manifest = await page.request.get(`${APP_URL}/manifest.webmanifest`);
    expect(manifest.ok()).toBeTruthy();
    expect((await manifest.json()).name).toBe("llm-chat");
    const sw = await page.request.get(`${APP_URL}/sw.js`);
    expect(sw.ok()).toBeTruthy();
    expect(await sw.text()).toContain("/api/");
    const apiResponse = await page.request.get(`${APP_URL}/api/health`);
    expect(apiResponse.headers()["cache-control"]).toBe("no-store");
  });

  test("PWA 离线保留应用壳且不会缓存 API", async ({ page, context }) => {
    test.skip(test.info().project.name !== "chromium", "Chromium 负责可靠的离线网络模拟");
    await page.goto(APP_URL);
    expect(await waitForServiceWorkerControl(page)).toBe(true);

    await context.setOffline(true);
    try {
      expect(await page.evaluate(async () => {
        try {
          await fetch("/api/bootstrap");
          return true;
        } catch {
          return false;
        }
      })).toBe(false);
      await page.goto(`${APP_URL}/settings/general`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).not.toBeEmpty();
      await expect(page.getByRole("alert")).toContainText("无法连接服务");
    } finally {
      await context.setOffline(false);
    }
  });
});

async function waitForServiceWorkerControl(page) {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return true;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 10_000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timeout);
        resolve(Boolean(navigator.serviceWorker.controller));
      }, { once: true });
    });
  });
}

test.describe("会话与流式生成", () => {
  test("配置连接与模型后完成一次流式对话", async ({ page, request }) => {
    const provider = await startMockProvider();
    let agentId = null;
    try {
      // Dedicated connection, discovered model and agent: no shared state mutated.
      const connection = await api(request, APP_URL, "POST", "/api/connections", {
        name: `e2e-${unique()}`,
        protocol: "openai-chat",
        baseUrl: provider.baseUrl,
        secretHeaders: {}
      });
      const discovery = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
      expect(discovery.discovered).toBe(1);
      const model = discovery.created[0];
      // trim 上下文策略要求模型声明上下文窗口。
      await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
      const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`流式-${unique()}`, model.id));
      agentId = agent.id;

      await page.goto(APP_URL);
      // Pick the dedicated agent in the composer.
      await page.getByLabel("选择 Agent").selectOption(agent.id);
      await expect(page.getByLabel("选择 Agent")).toHaveValue(agent.id);
      await page.getByLabel("输入消息").fill("你好，测试一下");
      await page.getByRole("button", { name: "发送", exact: true }).click();

      // Streaming reply, usage and final status render in the assistant message.
      await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
      await expect(page.getByText("合计 18")).toBeVisible();
      if (test.info().project.name !== "mobile-chromium") {
        await expect(page.getByText("已完成").first()).toBeVisible();
      }
      expect(provider.requests.at(-1)?.model).toBe("e2e-chat");

      // The conversation lives at a real path; opening it directly works.
      await expect(page).toHaveURL(/\/c\/[0-9a-f-]+/);
      const conversationUrl = page.url();
      await page.goto(`${APP_URL}/`);
      await page.goto(conversationUrl);
      await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();

      // Retry produces a second generation version that can be switched.
      await page.getByRole("button", { name: /重试/ }).click();
      await expect(page.getByText("2 / 2")).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "上一版本" }).click();
      await expect(page.getByText("1 / 2")).toBeVisible();

      // The Harness-style trajectory and inspector are projections of the
      // persisted generation, not a second execution runtime.
      await page.getByRole("tab", { name: "轨迹" }).click();
      await expect(page).toHaveURL(/\/trajectory$/);
      await expect(page.getByText("第 1 轮")).toBeVisible();
      await page.getByRole("button", { name: /生成 v1/ }).click();
      const inspector = page.getByRole("complementary", { name: "检查器" });
      await expect(inspector).toContainText("生成 v1");
      await expect(inspector).toContainText("有效设置");
      if (await inspector.getByRole("button", { name: "关闭检查器" }).isVisible()) {
        await inspector.getByRole("button", { name: "关闭检查器" }).click();
      }
      await page.getByRole("tab", { name: "对话" }).click();

      // Rename and then delete the conversation through the sidebar.
      await openDrawerIfNeeded(page);
      const item = page.locator(".conversation-row").first();
      await item.hover();
      await item.getByRole("button", { name: /重命名/ }).click();
      const title = `重命名-${unique()}`;
      await page.getByLabel("会话标题").fill(title);
      await page.getByRole("button", { name: "保存" }).click();
      await openDrawerIfNeeded(page);
      await expect(page.locator(".conversation-row").first()).toContainText(title);

      await openDrawerIfNeeded(page);
      const renamed = page.locator(".conversation-row", { hasText: title });
      await renamed.hover();
      await renamed.getByRole("button", { name: /删除/ }).click();
      await page.locator(".modal").getByRole("button", { name: "删除", exact: true }).click();
      await openDrawerIfNeeded(page);
      await expect(page.locator(".conversation-row", { hasText: title })).toHaveCount(0);
    } finally {
      if (agentId) await api(request, APP_URL, "DELETE", `/api/agents/${agentId}`).catch(() => {});
      await provider.close();
    }
  });

  test("会话执行覆盖完整编辑", async ({ page, request }) => {
    // Dedicated agent without a model; overrides are edited and verified via API.
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`覆盖-${unique()}`));
    try {
      const conversation = await api(request, APP_URL, "POST", "/api/conversations", {
        agentId: agent.id,
        title: `覆盖会话-${unique()}`
      });
      await gotoPath(page, `/c/${conversation.id}`);
      await page.getByRole("button", { name: "高级执行设置" }).click();
      const modal = page.locator(".modal");
      await expect(modal).toBeVisible();

      await modal.getByLabel("上下文策略").selectOption("full");
      await modal.getByLabel("推理档位").selectOption("high");
      await modal.getByLabel("温度").fill("0.7");
      await modal.getByLabel("最大输出 token").fill("2048");
      await modal.getByLabel("覆盖停止序列").check();
      await modal.getByLabel("停止序列（每行一个）").fill("STOP");
      await modal.getByLabel("推理摘要").selectOption("detailed");
      await modal.getByLabel("Thinking 预算（token）").fill("2048");

      // Per-tool override: pick the first catalog row and disable it.
      const firstToolRow = modal.locator(".tool-override-row").first();
      const toolSelect = firstToolRow.getByRole("combobox");
      await toolSelect.selectOption("off");
      const toolName = (await firstToolRow.locator("code").textContent())?.trim();

      await modal.getByRole("button", { name: "保存", exact: true }).click();
      await expect
        .poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides)
        .toMatchObject({
          contextPolicy: "full",
          reasoningEffort: "high",
          generation: {
            common: { temperature: 0.7, maxOutputTokens: 2048, stopSequences: ["STOP"] },
            protocol: { reasoningSummary: "detailed", thinkingBudgetTokens: 2048 }
          }
        });
      const saved = (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides;
      expect(saved.tools?.[toolName]).toBe(false);
      // modelId untouched: key must be absent, not null.
      expect(Object.hasOwn(saved, "modelId")).toBe(false);

      // Explicitly selecting no model and an empty stop list must remain
      // distinct from inheriting the Agent values.
      await page.getByRole("button", { name: "高级执行设置" }).click();
      const explicitModal = page.locator(".modal");
      await explicitModal.getByLabel("会话模型覆盖").selectOption("__none__");
      await explicitModal.getByLabel("停止序列（每行一个）").fill("");
      await explicitModal.getByRole("button", { name: "保存", exact: true }).click();
      const explicit = (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides;
      expect(explicit.modelId).toBeNull();
      expect(explicit.generation?.common?.stopSequences).toEqual([]);

      // Clearing removes every override field.
      await page.getByRole("button", { name: "高级执行设置" }).click();
      await page.getByRole("button", { name: "清除覆盖" }).click();
      await page.locator(".modal").getByRole("button", { name: "保存", exact: true }).click();
      await expect
        .poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides)
        .toEqual({});

      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    } finally {
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`).catch(() => {});
    }
  });

  test("未配置模型的 Agent 发送消息会收到明确错误", async ({ page, request }) => {
    // Dedicated agent with no model: default agent state stays untouched.
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`无模型-${unique()}`));
    try {
      await page.goto(APP_URL);
      await page.getByLabel("选择 Agent").selectOption(agent.id);
      await expect(page.getByLabel("选择 Agent")).toHaveValue(agent.id);
      await expect(page.getByLabel("输入消息")).toHaveAttribute("placeholder", "请先选择模型");
      await page.getByLabel("输入消息").fill("没有模型会怎样");
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    } finally {
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`).catch(() => {});
    }
  });
});

test.describe("Agent 管理", () => {
  test("创建、编辑并删除 Agent", async ({ page }) => {
    const name = `小猫助手-${unique()}`;
    await gotoPath(page, "/agents");
    await page.getByRole("button", { name: "新建 Agent" }).click();
    await page.getByLabel("名称").fill(name);
    await page.getByRole("button", { name: "创建" }).click();

    // Editor opens on the card tab; rename and save.
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const renamed = `${name}-v2`;
    await page.getByLabel("名称", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

    // Tool policy table lists catalog entries.
    await page.getByRole("tab", { name: "工具" }).click();
    await expect(page.getByRole("columnheader", { name: "审批" })).toBeVisible();

    // Back to list and delete.
    await page.getByRole("button", { name: "返回列表" }).click();
    const row = page.locator(".list-row", { hasText: renamed });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "删除" }).click();
    await expect(page.getByText("必须重新选择 Agent")).toBeVisible();
    await page.locator(".modal").getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.locator(".list-row", { hasText: renamed })).toHaveCount(0);
  });

  test("导入角色卡 JSON", async ({ page }) => {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: `导入角色-${unique()}`, description: "从 JSON 导入", first_mes: "你好呀" }
    };
    await gotoPath(page, "/agents");
    await page.getByLabel("选择角色卡文件").setInputFiles({
      name: "card.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(card))
    });
    await expect(page.getByRole("heading", { name: card.data.name })).toBeVisible();
  });
});

test.describe("设置分区", () => {
  test("管理列表在宽窄视口中保持操作区对齐", async ({ page, request }) => {
    const project = test.info().project.name;
    test.skip(!["chromium", "mobile-chromium"].includes(project), "Chromium 覆盖布局断点");

    const connection = await api(request, APP_URL, "POST", "/api/connections", {
      name: `布局测试连接-${unique()}`,
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:9/v1",
      secretHeaders: {}
    });

    const assertActionLayout = async (selector: string, stacked: boolean) => {
      const report = await page.locator(selector).evaluateAll((groups) => groups.map((group) => {
        const groupRect = group.getBoundingClientRect();
        const container = group.parentElement;
        const content = container?.querySelector(":scope > .list-row-content, :scope > .list-row-title");
        const contentRect = content?.getBoundingClientRect();
        return {
          right: groupRect.right,
          width: groupRect.width,
          contentBottom: contentRect?.bottom ?? null,
          top: groupRect.top,
          buttons: [...group.querySelectorAll("button, a.btn")].map((button) => ({
            height: button.getBoundingClientRect().height,
            whiteSpace: getComputedStyle(button).whiteSpace
          }))
        };
      }));

      expect(report.length).toBeGreaterThan(0);
      for (const group of report) {
        expect(group.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
        expect(group.width).toBeGreaterThan(0);
        for (const button of group.buttons) {
          expect(button.height).toBeLessThanOrEqual(32);
          expect(button.whiteSpace).toBe("nowrap");
        }
        if (stacked && group.contentBottom !== null) {
          expect(group.top).toBeGreaterThanOrEqual(group.contentBottom);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
        await page.evaluate(() => window.innerWidth)
      );
    };

    try {
      const widths = project === "mobile-chromium" ? [390] : [1728, 1440, 1024, 768, 390];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await gotoPath(page, "/settings/skills");
        await expect(page.locator(".list-row-actions").first()).toBeVisible();
        await assertActionLayout(".list-row .list-row-actions", width <= 900);
      }

      await page.setViewportSize({ width: 390, height: 1000 });
      await gotoPath(page, "/agents");
      await expect(page.locator(".list-row-actions").first()).toBeVisible();
      await assertActionLayout(".list-row .list-row-actions", true);

      await page.setViewportSize({ width: project === "mobile-chromium" ? 390 : 768, height: 1000 });
      await gotoPath(page, "/settings/connections");
      await expect(page.locator(".management-card-header .list-row-actions")).toBeVisible();
      await assertActionLayout(".management-card-header .list-row-actions", true);
    } finally {
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`).catch(() => {});
    }
  });

  test("工具目录与工具设置", async ({ page }) => {
    await gotoPath(page, "/settings/tools");
    await expect(page.getByRole("heading", { name: "工具目录" })).toBeVisible();
    await expect(page.locator(".table tbody tr").first()).toBeVisible();
    await expect(page.getByText("工作区：")).toBeVisible();
  });

  test("记忆列表为只读", async ({ page }) => {
    await gotoPath(page, "/settings/memories");
    await expect(page.getByRole("heading", { name: "长期记忆" })).toBeVisible();
  });

  test("MCP 服务表单校验名称", async ({ page }) => {
    await gotoPath(page, "/settings/mcp");
    await page.getByRole("button", { name: "添加服务" }).click();
    await page.getByLabel("名称").fill("bad name!");
    await page.getByLabel("URL").fill("https://example.com/mcp");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });
});
