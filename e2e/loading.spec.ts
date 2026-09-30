import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.use({ serviceWorkers: "block" });

async function chat(request: import("@playwright/test").APIRequestContext) {
  const provider = await startMockProvider({ responseText: "加载回归回复" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Loading", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("加载回归助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "已保存的历史消息" });
  await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
  return { provider, id: started.conversation.id, agent };
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
    await testInfo.attach("cached-first-screen.json", { body: JSON.stringify({ milliseconds: Date.now() - started, bootstrapPending: true }), contentType: "application/json" });
    await input.fill("刷新期间编辑的草稿");
    release();
    await expect(page.locator(".boot-refresh-notice")).toHaveCount(0);
    await expect(input).toHaveValue("刷新期间编辑的草稿");
    await expect(page).toHaveURL(`${APP_URL}/c/${id}`);
  } finally { release(); await page.goto("about:blank"); await provider.close(); }
});

test("离线标记不拦截发送，失败保留草稿且只在手动重试时发送", async ({ page, request }) => {
  const { provider, id } = await chat(request);
  const bodies: Array<{ clientSubmissionId: string }> = [];
  try {
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
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".composer-send-error")).toBeVisible();
    await expect(input).toHaveValue("手动重试的消息");
    expect(bodies).toHaveLength(1);
    await input.fill("下一条正在编辑");
    await page.locator(".composer-send-error").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".composer-send-error")).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(input).toHaveValue("下一条正在编辑");
    await expect(page.locator('.msg[data-role="user"]').last()).toContainText("手动重试的消息");
  } finally { await page.goto("about:blank"); await provider.close(); }
});

test("响应丢失后刷新页面再重试不会重复创建消息", async ({ page, request }) => {
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
    await expect(page.locator(".composer-send-error")).toBeVisible();
    await page.reload();
    await expect(page.locator(".composer-send-error")).toBeVisible();
    expect(bodies).toHaveLength(1);
    await page.locator(".composer-send-error").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".composer-send-error")).toHaveCount(0);
    expect(bodies[1]).toEqual(bodies[0]);
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
