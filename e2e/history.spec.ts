import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("撤回和重做跨页面保留原 ID，续写后可从恢复记录取回草稿", async ({ page, request, context }) => {
  const provider = await startMockProvider();
  let conversationId: string | undefined;
  let agentId: string | undefined;
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "history-test", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const discovery = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
    const model = discovery.created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("回溯测试", model.id)); agentId = agent.id;
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id }); conversationId = conversation.id;
    const path = `/api/conversations/${conversation.id}`;
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    const send = async (text: string) => {
      await page.getByLabel("输入消息").fill(text);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(async () => (await api(request, APP_URL, "GET", `${path}/messages`)).at(-1)?.generations.at(-1)?.status).toBe("completed");
    };
    const action = async (name: string) => {
      await page.getByRole("button", { name: "更多会话设置" }).click();
      await page.getByRole("button", { name, exact: true }).click();
    };
    await send("第一轮"); await send("第二轮");
    const original = await api(request, APP_URL, "GET", `${path}/messages`);
    const requests = provider.requests.length;
    await action("撤回上一轮");
    await expect.poll(async () => (await api(request, APP_URL, "GET", `${path}/messages`)).length).toBe(2);
    const secondDevice = await context.newPage();
    await secondDevice.goto(`${APP_URL}/c/${conversation.id}`);
    await secondDevice.getByRole("button", { name: "更多会话设置" }).click();
    await secondDevice.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `${path}/messages`)).map((message: { id: string }) => message.id)).toEqual(original.map((message: { id: string }) => message.id));
    expect(provider.requests).toHaveLength(requests);
    await secondDevice.close();
    await page.reload(); await action("撤回上一轮");
    await expect.poll(async () => (await api(request, APP_URL, "GET", `${path}/messages`)).length).toBe(2);
    await send("新的第二轮");
    await action("恢复记录");
    const dialog = page.getByRole("dialog", { name: "恢复记录" });
    await expect(dialog).toContainText("第二轮");
    await dialog.getByRole("button", { name: "恢复为草稿" }).click();
    await expect(page.getByLabel("输入消息")).toHaveValue("第二轮");
    expect((await api(request, APP_URL, "GET", `${path}/history`)).canRedo).toBe(false);
  } finally {
    if (conversationId) await api(request, APP_URL, "DELETE", `/api/conversations/${conversationId}`).catch(() => {});
    if (agentId) await api(request, APP_URL, "DELETE", `/api/agents/${agentId}`).catch(() => {});
    await provider.close();
  }
});
