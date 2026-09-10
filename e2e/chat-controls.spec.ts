import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { agentInput, api, APP_URL, openMessageActions } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

async function setup(request: APIRequestContext, baseUrl: string) {
  const connection = await api(request, APP_URL, "POST", "/api/connections", {
    name: `controls-${Date.now()}`, protocol: "openai-chat", baseUrl, secretHeaders: {}
  });
  const discovery = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
  const model = discovery.created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`controls-${Date.now()}`, model.id));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  return { conversation, model, agent, cleanup: async () => {
    const conversations = await api(request, APP_URL, "GET", "/api/conversations");
    for (const item of conversations.filter((item: { agentId: string }) => item.agentId === agent.id)) {
      await api(request, APP_URL, "DELETE", `/api/conversations/${item.id}/queued-messages`);
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${item.id}/messages`);
      for (const message of messages) for (const generation of message.generations) {
        if (["queued", "running", "waiting-approval"].includes(generation.status)) {
          await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
          await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${generation.id}`)).status).toMatch(/^(stopped|completed|failed)$/);
        }
      }
      await api(request, APP_URL, "DELETE", `/api/conversations/${item.id}`);
    }
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
  } };
}

async function checkToolbar(page: Page) {
  const geometry = await page.locator(".composer-tools").evaluate((toolbar) => {
    const rect = toolbar.getBoundingClientRect();
    const buttons = [...toolbar.querySelectorAll("button")].filter((button) => button.getClientRects().length).map((button) => {
      const box = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { x: box.x, y: box.y, right: box.right, width: box.width, height: box.height,
        iconX: icon.x, iconRight: icon.right, iconWidth: icon.width, iconHeight: icon.height,
        background: style.backgroundColor, border: parseFloat(style.borderTopWidth) };
    });
    return { left: rect.left, right: rect.right, buttons, fits: toolbar.scrollWidth <= toolbar.clientWidth };
  });
  expect(geometry.fits).toBe(true);
  for (const [index, button] of geometry.buttons.entries()) {
    expect(button.height).toBe(44);
    expect(button.width).toBeGreaterThanOrEqual(36);
    expect(button.iconWidth).toBe(26);
    expect(button.iconHeight).toBe(26);
    expect(button.background).toBe("rgba(0, 0, 0, 0)");
    expect(button.border).toBe(0);
    expect(button.x).toBeGreaterThanOrEqual(geometry.left);
    expect(button.right).toBeLessThanOrEqual(geometry.right + 0.1);
    if (index) {
      expect(button.y).toBe(geometry.buttons[index - 1]!.y);
      expect(button.x).toBeGreaterThanOrEqual(geometry.buttons[index - 1]!.right - 0.1);
      expect(button.iconX - geometry.buttons[index - 1]!.iconRight).toBeGreaterThanOrEqual(12);
    }
  }
}

test.describe("受控网络延迟", () => {
// Requests owned by a service worker can bypass the cancellation route used to hold the response.
test.use({ serviceWorkers: "block" });
test("工具栏大图标在宽窄屏和生成中保持分组与间距，品牌色适配主题", async ({ page, request }) => {
  const provider = await startMockProvider({ firstResponseDelayMs: 60_000 });
  const fixture = await setup(request, provider.baseUrl);
  try {
    await api(request, APP_URL, "PATCH", `/api/models/${fixture.model.id}`, { displayName: "DeepSeek 工具栏测试" });
    await api(request, APP_URL, "PATCH", `/api/conversations/${fixture.conversation.id}`, { executionOverrides: { reasoningEffort: "none" } });
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    const brand = page.getByRole("button", { name: "选择模型" }).locator(".model-brand-icon");
    await expect(brand.locator('path[fill="#4D6BFE"]')).toHaveCount(1);
    await expect(page.locator(".composer-tools .lucide-chevron-down")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "选择 Agent", exact: true })).toHaveText("");
    await expect(page.locator(".composer-tools").getByRole("button", { name: "选择工作目录" })).toHaveCount(0);
    await expect(page.locator(".composer-tools").getByRole("button", { name: "会话操作", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "低频设置" }).click();
    await page.getByRole("button", { name: "选择工作目录" }).click();
    await expect(page.getByRole("dialog", { name: "选择工作目录" })).toBeVisible();
    await page.getByRole("dialog", { name: "选择工作目录" }).getByRole("button", { name: "关闭对话框" }).click();
    await page.locator(".conversation-header").getByRole("button", { name: "会话操作", exact: true }).click();
    await expect(page.getByRole("button", { name: "立即压缩上下文" })).toBeVisible();
    await expect(page.getByRole("button", { name: /撤回|重做|恢复记录|回溯至此轮/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    if (test.info().project.name === "mobile-chromium") {
      await page.setViewportSize({ width: 280, height: 844 });
      await expect(page.locator(".composer-tools").getByRole("button", { name: "选择 Agent", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "低频设置" }).click();
      await page.getByRole("button", { name: "选择 Agent", exact: true }).click();
      await page.getByRole("searchbox", { name: "搜索 Agent" }).fill(fixture.agent.name);
      await page.getByRole("button", { name: fixture.agent.name, exact: true }).click();
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator(".composer-tools").getByRole("button", { name: "选择 Agent", exact: true })).toBeVisible();
    }
    const idlePositions = new Map<number, unknown>();
    for (const generating of [false, true]) {
      if (generating) {
        await page.getByLabel("输入消息").fill("保持生成以验证工具栏");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(page.locator(".composer").getByRole("button", { name: "停止生成" })).toBeVisible();
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const width of [320, 390, 640, 1440]) {
          await page.setViewportSize({ width, height: 844 });
          await expect(() => checkToolbar(page)).toPass({ timeout: 3000 });
          const positions = await page.locator(".composer-tools").evaluate((toolbar) => [...toolbar.querySelectorAll("button")].filter((button) => button.getClientRects().length).map((button) => {
            const box = button.getBoundingClientRect();
            return { x: box.x, width: box.width, y: box.y - toolbar.getBoundingClientRect().y };
          }));
          if (!generating) idlePositions.set(width, positions);
          else expect(positions).toEqual(idlePositions.get(width));
          const badge = page.locator('.composer-tools .composer-settings-trigger > b:visible');
          if (await badge.count()) {
            const bounds = await badge.evaluate((element) => {
              const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect();
              return { fits: box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom };
            });
            expect(bounds.fits).toBe(true);
          }
          if (test.info().project.name === "mobile-chromium" && width <= 390) {
            await page.screenshot({ path: test.info().outputPath(`toolbar-${width}-${theme}-${generating ? "generating" : "idle"}.png`) });
          }
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 844 });
    const stop = page.locator(".composer").getByRole("button", { name: "停止生成" });
    await expect(stop).toHaveCSS("width", "44px");
    await expect(stop).toHaveCSS("height", "44px");
    let releaseCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => { releaseCancel = resolve; });
    await page.route("**/api/generations/*/cancel", async (route) => { await cancellation; await route.continue(); });
    await stop.click();
    try {
      await expect(page.locator(".composer").getByRole("button", { name: "正在取消" })).toBeDisabled();
      await checkToolbar(page);
      await expect(page.locator(".composer-tools").getByRole("button", { name: "添加附件" })).toBeVisible();
    } finally { releaseCancel(); }
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    await page.unroute("**/api/generations/*/cancel");
    await api(request, APP_URL, "PATCH", `/api/models/${fixture.model.id}`, { displayName: "Kimi 工具栏测试" });
    await page.reload();
    await expect(brand).toHaveAttribute("data-brand", "kimi");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await expect(brand.locator('path[fill="#1783FF"]')).toHaveCSS("fill", "rgb(23, 131, 255)");
      expect(await brand.locator("path").nth(1).evaluate((element) => getComputedStyle(element).fill))
        .toBe(await brand.evaluate((element) => getComputedStyle(element).color));
    }
  } finally { await fixture.cleanup(); await provider.close(); }
});
});

test("生成中排队、跨设备同步、删除与取消后继续", async ({ page, browser, request }) => {
  const provider = await startMockProvider({ firstResponseDelayMs: 5000 });
  const fixture = await setup(request, provider.baseUrl);
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await page.getByLabel("输入消息").fill("first");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".composer").getByRole("button", { name: "停止生成" })).toBeVisible();
    if (test.info().project.name === "mobile-chromium") await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.locator(".composer-tools").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const text of ["keep-a", "remove-b", "keep-c"]) {
      await page.getByLabel("输入消息").fill(text);
      await page.getByRole("button", { name: "加入队列", exact: true }).click();
      await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toContainText(text);
    }
    const second = await other.newPage();
    await second.goto(page.url());
    await expect(second.getByLabel("输入消息")).toHaveValue("");
    await expect(second.getByRole("region", { name: "待发送消息", exact: true })).toContainText("remove-b");
    await page.getByRole("button", { name: "删除待发送消息 remove-b" }).click();
    await expect(second.getByRole("region", { name: "待发送消息", exact: true })).not.toContainText("remove-b");
    await page.reload();
    await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toContainText("keep-c");
    await page.locator(".composer").getByRole("button", { name: "停止生成" }).click();
    await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toHaveCount(0);
    await expect(second.getByLabel("消息列表", { exact: true }).getByText("keep-c", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
      return messages.at(-1)?.generations[0]?.status;
    }).toBe("completed");
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
    expect(messages.filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text)).toEqual(["first", "keep-a", "keep-c"]);
    expect(messages[1].generations[0].status).toBe("stopped");
  } finally { await other.close(); await fixture.cleanup(); await provider.close(); }
});

test("附件菜单、灯泡滑条与历史附件编辑分叉", async ({ page, request }) => {
  const provider = await startMockProvider();
  const fixture = await setup(request, provider.baseUrl);
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await expect(page.getByRole("button", { name: "选择模型" }).locator(".model-brand-icon")).toBeVisible();
    await expect(page.locator(".composer .lucide-image-plus")).toHaveCount(0);
    if (test.info().project.name === "mobile-chromium") await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("button", { name: "选择 Agent", exact: true }).click();
    const agentMenu = page.getByRole("dialog", { name: "Agent 选择", exact: true });
    await expect(agentMenu).toHaveAttribute("data-side", "top");
    const agentBox = await agentMenu.boundingBox();
    expect(agentBox!.x).toBeGreaterThanOrEqual(0);
    expect(agentBox!.x + agentBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (test.info().project.name === "mobile-chromium") await expect(page.getByRole("searchbox", { name: "搜索 Agent" })).not.toBeFocused();
    await agentMenu.locator(".agent-option[aria-pressed=true]").click();
    await expect(agentMenu).toHaveCount(0);
    await page.getByRole("button", { name: /^推理档位：/ }).click();
    const slider = page.getByRole("slider", { name: "推理档位" });
    await expect(slider).toHaveAttribute("aria-orientation", "vertical");
    const box = await page.locator(".reasoning-popover").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "添加附件" }).click();
    await expect(page.getByRole("button", { name: "上传图片", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上传文件", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("original") });
    await expect(page.getByLabel("待发送附件")).toContainText("original.txt");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
    await openMessageActions(page, page.locator('.msg[data-role="user"]').last());
    await page.getByRole("button", { name: "编辑并分叉", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑并分叉" });
    await dialog.getByRole("button", { name: "移除 original.txt" }).click();
    await expect(dialog.getByRole("button", { name: "创建分支并生成" })).toBeDisabled();
    await dialog.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
    await expect(dialog.getByLabel("待发送附件")).toContainText("replacement.txt");
    await dialog.getByRole("button", { name: "创建分支并生成" }).click();
    await expect(page).not.toHaveURL(new RegExp(fixture.conversation.id));
    await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
    const forkId = page.url().split("/").at(-1);
    const original = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
    const fork = await api(request, APP_URL, "GET", `/api/conversations/${forkId}/messages`);
    expect(original[0].attachments.map((asset: { fileName: string }) => asset.fileName)).toEqual(["original.txt"]);
    expect(fork[0].attachments.map((asset: { fileName: string }) => asset.fileName)).toEqual(["replacement.txt"]);
  } finally { await fixture.cleanup(); await provider.close(); }
});

test("聊天排版实时预览且仅在同一浏览器同步，离线可调整", async ({ page, browser, request }) => {
  const provider = await startMockProvider();
  const fixture = await setup(request, provider.baseUrl);
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  await other.addInitScript(() => localStorage.setItem("llm-chat.quick-tour.v1", "seen"));
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await page.getByLabel("输入消息").fill("排版测试");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
    await page.getByLabel("输入消息").fill("保留这份草稿\nHello, typography preview");
    const independent = await other.newPage();
    await independent.goto(`${APP_URL}/settings/general`);
    const independentSize = independent.getByRole("slider", { name: "字号", exact: true });
    await expect(independentSize).toBeVisible();
    const originalSize = await independentSize.inputValue();
    const second = await page.context().newPage();
    await second.goto(`${APP_URL}/settings/general`);
    await expect(second.getByRole("slider", { name: "字号", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "低频设置" }).click();
    await page.getByRole("button", { name: /聊天排版/ }).click();
    const size = page.getByRole("slider", { name: "字号", exact: true });
    const bounds = (await size.boundingBox())!;
    const touch = test.info().project.name === "mobile-chromium" ? await page.context().newCDPSession(page) : null;
    if (touch) {
      const current = Number(await size.inputValue());
      const x = bounds.x + 8 + (bounds.width - 16) * (current - 12) / 12;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: bounds.y + bounds.height / 2 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bounds.x + bounds.width * .8, y: bounds.y + bounds.height / 2 }] });
    } else {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height / 2, { steps: 4 });
    }
    const value = Number(await size.inputValue());
    expect(value).toBeGreaterThan(18);
    await expect(page.getByLabel("输入消息")).toHaveCSS("font-size", `${value}px`);
    await expect(page.locator('.chat-thread .msg[data-role="assistant"]').last()).toHaveCSS("font-size", `${value}px`);
    if (touch) { await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach(); }
    else await page.mouse.up();
    await expect(second.getByRole("slider", { name: "字号", exact: true })).toHaveValue(String(value));
    await expect(second.locator('.chat-typography-preview .msg').first()).toHaveCSS("font-size", `${value}px`);
    const lineHeight = page.getByRole("slider", { name: "行间距", exact: true });
    let typographyWrites = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().endsWith("/api/settings") &&
          /chatFontSize|chatLineHeight|chatLetterSpacing/.test(request.postData() ?? "")) typographyWrites++;
    });
    await lineHeight.focus();
    await lineHeight.press("ArrowRight");
    await expect(page.getByLabel("输入消息")).toHaveCSS("line-height", `${value * 1.6}px`);
    await expect(second.getByRole("slider", { name: "行间距", exact: true })).toHaveValue("1.6");
    await expect(independentSize).toHaveValue(originalSize);
    expect(typographyWrites).toBe(0);
    await page.getByLabel("输入消息").click();
    await page.getByLabel("输入消息").press("End");
    await page.getByLabel("输入消息").press("!");
    await expect(size).toBeVisible();
    await expect(page.getByLabel("输入消息")).toHaveValue(/保留这份草稿/);
    await expect(page.locator('.modal-backdrop:visible')).toHaveCount(0);
    const panel = (await page.locator('.composer-settings-popover').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: test.info().outputPath("typography-floating-preview.png") });
    await page.getByRole("button", { name: "关闭排版面板" }).click();
    await page.reload();
    await expect(page.getByLabel("输入消息")).toHaveCSS("font-size", `${value}px`);
    await expect(page.getByLabel("输入消息")).toHaveValue(/保留这份草稿/);
    const spacing = second.getByRole("slider", { name: "字间距", exact: true });
    await spacing.focus();
    await spacing.press("ArrowRight");
    await expect(page.getByLabel("输入消息")).toHaveCSS("letter-spacing", `${value * .01}px`);
    await page.context().setOffline(true);
    await expect(second.getByRole("slider", { name: "字号", exact: true })).toBeEnabled();
    await second.getByRole("button", { name: "恢复默认" }).click();
    await expect(page.getByLabel("输入消息")).toHaveCSS("font-size", "13.5px");
    expect(typographyWrites).toBe(0);
    await page.context().setOffline(false);
    await second.close();
  } finally {
    await other.close();
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: original.uiPreferences });
    await fixture.cleanup(); await provider.close();
  }
});

test("排版调整保留历史段落位置，悬浮面板打开时仍能滚动聊天", async ({ page, request }) => {
  const paragraphs = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：这是一段用于检查阅读位置的文字。Typography should preserve the paragraph being read.`);
  const provider = await startMockProvider({ responseText: paragraphs.join("\n\n") });
  const fixture = await setup(request, provider.baseUrl);
  const original = await api(request, APP_URL, "GET", "/api/settings");
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await page.getByLabel("输入消息").fill("长回复");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(paragraphs[59]!, { exact: true })).toBeAttached();
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    const scroller = page.getByLabel("消息列表", { exact: true });
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.getByRole("button", { name: "低频设置" }).click();
    await page.getByRole("button", { name: /聊天排版/ }).click();
    const size = page.getByRole("slider", { name: "字号", exact: true });
    await size.focus();
    await size.press("ArrowRight");
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    const paragraph = page.getByText(paragraphs[20]!, { exact: true });
    await paragraph.evaluate((element) => {
      const container = element.closest('.chat-scroll')!;
      container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
    const before = (await paragraph.boundingBox())!.y;
    await size.focus();
    await size.press("ArrowRight");
    await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - before)).toBeLessThan(2);
    const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
    const bounds = (await scroller.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width - 10, bounds.y + 20);
    await page.mouse.wheel(0, -120);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(scrollBefore);
    await expect(size).toBeVisible();
    await size.focus();
    await size.press("End");
    await page.getByRole("slider", { name: "字间距", exact: true }).focus();
    await page.getByRole("slider", { name: "字间距", exact: true }).press("End");
    expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(size).toHaveCount(0);
  } finally {
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: original.uiPreferences });
    await fixture.cleanup(); await provider.close();
  }
});

test("远端删除只提示一次并清理离线记录，保留冲突草稿", async ({ page, request }) => {
  const provider = await startMockProvider();
  const fixture = await setup(request, provider.baseUrl);
  const id = fixture.conversation.id;
  try {
    await page.goto(APP_URL);
    await page.getByLabel("输入消息").fill("原来的新会话草稿");
    await page.goto(`${APP_URL}/c/${id}`);
    await page.getByLabel("输入消息").fill("被删除会话的草稿");
    await expect.poll(() => page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("llm-chat-history"); r.onsuccess = () => resolve(r.result); });
      try { return await new Promise<boolean>((resolve) => { const r = db.transaction("conversations").objectStore("conversations").get(id); r.onsuccess = () => resolve(Boolean(r.result)); }); }
      finally { db.close(); }
    }, id)).toBe(true);
    await page.evaluate(() => {
      (window as any).__deletedToasts = 0;
      new MutationObserver((mutations) => {
        for (const m of mutations) for (const node of m.addedNodes) {
          if (node instanceof Element && node.matches(".toast") && node.textContent?.includes("会话已删除")) (window as any).__deletedToasts++;
        }
      }).observe(document.body, { subtree: true, childList: true });
    });
    await api(request, APP_URL, "DELETE", `/api/conversations/${id}`);
    await expect(page).toHaveURL(APP_URL + "/");
    await expect(page.getByLabel("输入消息")).toHaveValue("被删除会话的草稿");
    await expect(page.getByText("会话已删除", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "切换保留的草稿" }).click();
    await expect(page.getByLabel("输入消息")).toHaveValue("原来的新会话草稿");
    await page.getByRole("button", { name: "切换保留的草稿" }).click();
    await expect(page.getByLabel("输入消息")).toHaveValue("被删除会话的草稿");
    await expect.poll(() => page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("llm-chat-history"); r.onsuccess = () => resolve(r.result); });
      try {
        const read = (store: string, key: string) => new Promise<any>((resolve) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result); });
        return !(await read("conversations", id)) && !(await read("meta", "manifest"))?.conversations.some((c: any) => c.id === id);
      } finally { db.close(); }
    }, id)).toBe(true);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    await expect.poll(() => page.evaluate(() => (window as any).__deletedToasts)).toBe(1);
    await page.goto(`${APP_URL}/c/${id}`);
    await expect(page).toHaveURL(APP_URL + "/");
    await expect(page.getByText("会话已删除", { exact: true })).toHaveCount(0);
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.getByLabel("输入消息")).toHaveValue("被删除会话的草稿");
    await page.context().setOffline(false);
  } finally { await fixture.cleanup(); await provider.close(); }
});
