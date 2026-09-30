import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.use({ serviceWorkers: "block" });

test("没有启动缓存也直接显示可操作界面，首次同步保持输入节点与草稿", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/bootstrap*", async route => { await pending; await route.continue().catch(() => {}); });
  try {
    await page.goto(APP_URL!, { waitUntil: "domcontentloaded" });
    const input = page.getByLabel("输入消息", { exact: true });
    await expect(input).toBeEditable();
    await expect(page.locator(".boot-screen, .offline-banner, .boot-refresh-notice")).toHaveCount(0);
    await input.fill("首次同步前的草稿");
    await input.evaluate(element => { (window as unknown as { startupInput: Element }).startupInput = element; });
    await openDrawerIfNeeded(page);
    const sidebar = page.locator(".workspace-sidebar");
    await expect(sidebar.getByRole("button", { name: "新会话", exact: true })).toBeEnabled();
    const response = page.waitForResponse(response => response.url().includes("/api/bootstrap") && response.ok());
    release(); await response;
    await expect(input).toHaveValue("首次同步前的草稿");
    expect(await input.evaluate(element => element === (window as unknown as { startupInput: Element }).startupInput)).toBe(true);
  } finally { release(); }
});

test("完整历史同步关闭时仍先恢复模型与提供商，连接未完成也能打开设置", async ({ page, request }, testInfo) => {
  const { provider, id, model } = await chat(request);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.addInitScript(() => localStorage.setItem("llm-chat.offline-enabled", "false"));
    await page.goto(`${APP_URL}/c/${id}`);
    await expect(page.getByRole("button", { name: "选择模型", exact: true })).toHaveAttribute("title", model.displayName);
    await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("llm-chat.startup.v1")))).toBe(true);
    await page.route("**/api/bootstrap*", async route => { await pending; await route.continue().catch(() => {}); });
    await page.reload({ waitUntil: "domcontentloaded" });
    const input = page.getByLabel("输入消息", { exact: true });
    await expect(input).toBeEditable();
    await expect(page.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
    await input.fill("连接期间继续输入");
    await openDrawerIfNeeded(page);
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "连接与模型", exact: true }).click();
    await expect(page.getByRole("button", { name: "新建连接", exact: true })).toBeEnabled();
    await expect(page.getByText("Loading", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建连接", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("cached-catalog-with-pending-bootstrap.png") });
    release();
  } finally { release(); await page.goto("about:blank"); await provider.close(); }
});

async function chat(request: import("@playwright/test").APIRequestContext) {
  const provider = await startMockProvider({ responseText: "加载回归回复" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Loading", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("加载回归助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "已保存的历史消息" });
  await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
  return { provider, id: started.conversation.id, agent, model };
}

test("启动请求未返回时先展示缓存，后台刷新不覆盖正在输入的草稿", async ({ page, request }, testInfo) => {
  const { provider, id } = await chat(request);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(`${APP_URL}/settings/general`);
    await expect(page.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
    let finished = false;
    await page.route("**/api/bootstrap*", async route => {
      await gate; finished = true;
      await route.continue().catch(() => {});
    });
    const started = Date.now();
    await page.goto(`${APP_URL}/c/${id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('.msg[data-role="user"]')).toContainText("已保存的历史消息");
    const input = page.getByLabel("输入消息", { exact: true });
    await expect(input).toBeEditable();
    expect(finished).toBe(false);
    await expect(page.locator(".boot-refresh-notice, .offline-banner")).toHaveCount(0);
    const positions = async () => ({ header: (await page.locator(".conversation-header").boundingBox())!.y, input: (await input.boundingBox())!.y });
    const before = await positions();
    await testInfo.attach("cached-first-screen.json", { body: JSON.stringify({ milliseconds: Date.now() - started, bootstrapPending: true }), contentType: "application/json" });
    await input.fill("刷新期间编辑的草稿");
    const response = page.waitForResponse(response => response.url().includes("/api/bootstrap") && response.ok());
    release();
    await response;
    await expect.poll(() => finished).toBe(true);
    await expect(page.locator(".boot-refresh-notice, .offline-banner")).toHaveCount(0);
    await expect(input).toHaveValue("刷新期间编辑的草稿");
    await expect.poll(positions).toEqual(before);
    await expect(page).toHaveURL(`${APP_URL}/c/${id}`);
  } finally { release(); await page.goto("about:blank"); await provider.close(); }
});

test("离线标记不拦截发送，失败保留草稿且只在手动重试时发送", async ({ page, request }) => {
  const { provider, id } = await chat(request);
  const bodies: Array<{ clientSubmissionId: string }> = [];
  try {
    await page.addInitScript(() => localStorage.setItem("llm-chat.requests.v1", JSON.stringify({ maxRetries: 0 })));
    await page.goto(`${APP_URL}/c/${id}`);
    const input = page.getByLabel("输入消息", { exact: true });
    await input.fill("手动重试的消息");
    await page.route(`**/api/conversations/${id}/messages`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) return route.abort("failed");
      return route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator(".boot-refresh-notice, .offline-banner")).toHaveCount(0);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".pending-message").getByRole("alert")).toBeVisible();
    await expect(page.locator(".composer-send-error, .pending-message-status")).toHaveCount(0);
    await expect(input).toHaveValue("手动重试的消息");
    expect(bodies).toHaveLength(1);
    await input.fill("下一条正在编辑");
    await page.locator(".pending-message").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".pending-message")).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(input).toHaveValue("下一条正在编辑");
    await expect(page.locator('.msg[data-role="user"]').last()).toContainText("手动重试的消息");
  } finally { await page.goto("about:blank"); await provider.close(); }
});

test("默认重试两次，待提交消息使用正常按钮并保留随后输入的草稿", async ({ page, request }) => {
  const { provider, id } = await chat(request);
  const attempts: Array<{ body: unknown; requestId: string | undefined }> = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route(`**/api/conversations/${id}/messages`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push({ body: route.request().postDataJSON(), requestId: route.request().headers()["x-llm-chat-request-id"] });
      if (attempts.length === 1) await gate;
      if (attempts.length <= 2) return route.abort("failed");
      return route.continue();
    });
    await page.goto(`${APP_URL}/c/${id}`);
    const input = page.getByLabel("输入消息", { exact: true });
    await input.fill("自动重试也只发一次");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const pending = page.locator(".pending-message");
    await expect(pending.getByRole("button", { name: "复制消息", exact: true })).toBeEnabled();
    await expect(pending.getByRole("button", { name: "编辑并分叉", exact: true })).toBeEnabled();
    await expect(pending.getByRole("button", { name: "停止生成", exact: true })).toBeEnabled();
    await expect(page.locator(".composer-send-error, .pending-message-status, .offline-banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
    await input.fill("自动重试期间的新草稿");
    release();
    await expect(page.locator('.msg[data-role="user"]').last()).toContainText("自动重试也只发一次");
    await expect(pending).toHaveCount(0);
    await expect(input).toHaveValue("自动重试期间的新草稿");
    expect(attempts).toHaveLength(3);
    expect(attempts.every(attempt => JSON.stringify(attempt) === JSON.stringify(attempts[0]))).toBe(true);
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${id}/messages`);
    expect(messages.filter((message: { role: string; text: string }) => message.role === "user" && message.text === "自动重试也只发一次")).toHaveLength(1);
  } finally { release(); await page.goto("about:blank"); await provider.close(); }
});

test("重试次数在通用设置中保存，发送重试用尽后由消息原按钮处理", async ({ page, request }) => {
  const { provider, id } = await chat(request);
  let attempts = 0;
  try {
    await page.goto(`${APP_URL}/settings/general`);
    const retries = page.getByLabel("请求失败重试次数", { exact: true });
    await expect(retries).toHaveValue("2");
    await retries.fill("1"); await page.reload();
    await expect(retries).toHaveValue("1");
    await page.route(`**/api/conversations/${id}/messages`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++; return route.abort("failed");
    });
    await page.goto(`${APP_URL}/c/${id}`);
    await page.getByLabel("输入消息", { exact: true }).fill("保留失败的请求");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const pending = page.locator(".pending-message");
    await expect(pending.getByRole("alert")).toBeVisible();
    expect(attempts).toBe(2);
    await pending.getByRole("button", { name: "编辑并分叉", exact: true }).click();
    await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("保留失败的请求");
    await expect(pending.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.reload();
    await expect(pending.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    expect(attempts).toBe(2);
  } finally { await page.goto("about:blank"); await provider.close(); }
});

test("响应丢失后通知或只读核对确认提交，刷新不会重复发送", async ({ page, request }) => {
  const { provider, id } = await chat(request);
  const bodies: Array<{ clientSubmissionId: string }> = [];
  try {
    await page.route(`**/api/conversations/${id}/messages`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        const accepted = await route.fetch(); expect(accepted.status()).toBe(202);
        return route.abort("failed");
      }
      return route.continue();
    });
    await page.goto(`${APP_URL}/c/${id}`);
    await page.getByLabel("输入消息", { exact: true }).fill("只应创建一次");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('.msg[data-role="user"]').last()).toContainText("只应创建一次");
    await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("");
    await page.reload();
    await expect(page.locator('.msg[data-role="user"]').last()).toContainText("只应创建一次");
    await expect(page.locator(".composer-send-error")).toHaveCount(0);
    expect(bodies).toHaveLength(1);
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${id}/messages`);
    expect(messages.filter((message: { role: string; text: string }) => message.role === "user" && message.text === "只应创建一次")).toHaveLength(1);
  } finally { await page.goto("about:blank"); await provider.close(); }
});

test("Agent 辅助资源加载失败仍可编辑主体", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("辅助加载失败测试"));
  await page.route("**/api/tools/catalog*", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "工具目录暂时不可用" } }) }));
  await page.goto(`${APP_URL}/agents/${agent.id}`);
  await expect(page.getByRole("tab", { name: "执行配置" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("工具目录暂时不可用");
  await page.getByRole("button", { name: "展开编辑基础系统提示", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "基础系统提示", exact: true });
  await editor.getByRole("textbox").fill("辅助资源失败时仍能编辑");
  await editor.getByRole("button", { name: "应用", exact: true }).click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).execution.baseSystemPrompt).toBe("辅助资源失败时仍能编辑");
});
