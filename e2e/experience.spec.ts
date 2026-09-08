import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.describe("首次教程", () => {
  test.use({ showTour: true });
  test("仅本浏览器记住跳过，设置中可重放并关闭", async ({ page }) => {
    await page.goto(APP_URL);
    const tour = page.getByRole("dialog", { name: "快速开始" });
    await expect(tour).toBeVisible();
    await tour.getByRole("button", { name: "跳过教程" }).click();
    await page.reload(); await expect(page.locator(".composer-input")).toBeVisible();
    await expect(tour).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("llm-chat.quick-tour.v1"))).toBe("seen");
    await page.goto(`${APP_URL}/settings/general`);
    await page.getByRole("button", { name: "重放快速教程" }).click();
    await tour.getByRole("button", { name: "下一步" }).click();
    await tour.getByRole("button", { name: "下一步" }).click();
    await expect(tour).toContainText("Steer");
    await tour.getByRole("button", { name: "关闭对话框" }).click();
    await expect(tour).toHaveCount(0);
  });
});

test("强调色、HSV 与纯黑背景持久化，振动提示分行", async ({ page, request }) => {
  const original = await api(request, APP_URL, "GET", "/api/settings");
  try {
    await page.addInitScript(() => Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined }));
    await page.goto(`${APP_URL}/settings/general`);
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await page.getByRole("button", { name: "蓝色", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("#018EEE");
    await page.getByLabel("深色模式使用纯黑背景").check();
    await expect(page.locator("html")).toHaveAttribute("data-amoled", "true");
    expect(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--bg").trim())).toBe("#000000");
    const label = page.locator(".haptics-label");
    expect(await label.evaluate((element) => element.children[1]!.getBoundingClientRect().top >= element.children[0]!.getBoundingClientRect().bottom)).toBe(true);
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-amoled", "true");
    await page.getByText("自定义 HSV 颜色", { exact: true }).click();
    await page.getByLabel("色相", { exact: true }).fill("120");
    await page.getByLabel("饱和度", { exact: true }).fill("100");
    await page.getByLabel("明度", { exact: true }).fill("100");
    await page.getByRole("button", { name: "应用颜色" }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("#00ff00");
  } finally { await api(request, APP_URL, "PATCH", "/api/settings", { theme: original.theme, uiPreferences: original.uiPreferences }); }
});

test("Agent 搜索分页保留搜索与页码，按设备决定焦点", async ({ page, request }) => {
  const ids: string[] = []; const prefix = `目录测试-${Date.now()}`;
  try {
    for (let i = 0; i < 14; i++) ids.push((await api(request, APP_URL, "POST", "/api/agents", agentInput(`${prefix}-${i}`))).id);
    await page.goto(`${APP_URL}/agents`);
    const input = page.getByRole("searchbox", { name: "搜索 Agent 列表" });
    await expect(input).toBeVisible();
    if (test.info().project.name === "mobile-chromium") await expect(input).not.toBeFocused(); else await expect(input).toBeFocused();
    await input.fill(prefix);
    await expect(page.locator(".agent-list-row")).toHaveCount(12);
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.locator(".agent-list-row")).toHaveCount(2);
    await page.locator(".agent-card-main").first().click();
    await page.getByRole("button", { name: "返回列表" }).click();
    await expect(input).toHaveValue(prefix);
    await expect(page.locator(".agent-list-row")).toHaveCount(2);
  } finally { for (const id of ids) await api(request, APP_URL, "DELETE", `/api/agents/${id}`); }
});

test("搜索标题和正文并高亮，通过菜单管理会话", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: "这里包含海岸灯塔搜索标记" });
  let id: string | undefined; let agentId: string | undefined;
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "search fixture", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("搜索测试", model.id)); agentId = agent.id;
    const result = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId, text: "搜索测试标题" }); id = result.conversation.id;
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${result.generation.generationId}`)).status).toBe("completed");
    await page.goto(APP_URL); await openDrawerIfNeeded(page);
    await page.getByRole("button", { name: "搜索会话", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索会话" });
    await dialog.getByRole("searchbox").fill("灯塔");
    await expect(dialog.locator("mark")).toHaveText("灯塔");
    await dialog.locator(".conversation-search-result").click();
    await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
    await openDrawerIfNeeded(page);
    const row = page.locator('.conversation-row[data-active="true"]:visible');
    await expect(row).toBeInViewport();
    await expect(row.getByRole("button", { name: /删除|重命名/ })).toHaveCount(0);
    await row.getByRole("button", { name: /会话操作/ }).click();
    await expect(page.getByRole("button", { name: /重命名 搜索测试标题/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /删除 搜索测试标题/ })).toBeVisible();
  } finally {
    if (id) await api(request, APP_URL, "DELETE", `/api/conversations/${id}`).catch(() => {});
    if (agentId) await api(request, APP_URL, "DELETE", `/api/agents/${agentId}`).catch(() => {});
    await provider.close();
  }
});

test("长按 Enter 或发送按钮生成一次 Steer，释放不重复发送", async ({ page, request }) => {
  const provider = await startMockProvider({ firstResponseDelayMs: 60_000 });
  let id: string | undefined;
  let generationId: string | undefined;
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "steer fixture", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Steer测试", model.id));
    const result = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "start" }); id = result.conversation.id; generationId = result.generation.generationId;
    await page.goto(`${APP_URL}/c/${id}`);
    await page.getByLabel("输入消息").fill("下一次请求前加入");
    if (test.info().project.name === "mobile-chromium") {
      const send = page.getByRole("button", { name: "加入队列" });
      await send.click({ trial: true });
      const box = (await send.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${id}/queued-messages`)).length).toBe(1);
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.keyboard.down("Enter");
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${id}/queued-messages`)).length).toBe(1);
      await page.keyboard.up("Enter");
    }
    expect(await api(request, APP_URL, "GET", `/api/conversations/${id}/queued-messages`)).toEqual([expect.objectContaining({ mode: "steer", text: "下一次请求前加入" })]);
    await expect(page.getByText("Steer · 下次请求")).toBeVisible();
    await api(request, APP_URL, "DELETE", `/api/conversations/${id}/queued-messages`);
    await api(request, APP_URL, "POST", `/api/generations/${result.generation.generationId}/cancel`);
  } finally {
    if (id) await api(request, APP_URL, "DELETE", `/api/conversations/${id}/queued-messages`).catch(() => {});
    if (generationId) await api(request, APP_URL, "POST", `/api/generations/${generationId}/cancel`).catch(() => {});
    await provider.close();
  }
});
