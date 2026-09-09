import type { MessageDto } from "@llm-chat/contracts";
import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openMessageActions } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("回复密度、常驻操作和推理展开在宽窄屏保持稳定", async ({ page, request }, testInfo) => {
  const provider = await startMockProvider({ responseText: "你好！有需要尽管说。", cachedInputTokens: 8 });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Reply layout", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("回复布局助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "你好" });
  try {
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    const reply = page.locator('.msg[data-role="assistant"]').last();
    await expect(reply.getByText("你好！有需要尽管说。")).toBeVisible();
    await expect(page.locator(".toast.error")).toHaveCount(0);
    await reply.evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
    const mobile = testInfo.project.name === "mobile-chromium";
    for (const width of mobile ? [360, 390] : [768, 1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        await page.mouse.move(0, 0);
        await expect(reply.locator(".process-disclosure")).not.toHaveAttribute("open");
        await expect(reply.locator(".msg-head")).toHaveCount(0);
        const before = await reply.boundingBox();
        expect(before!.height).toBeLessThanOrEqual(mobile ? 160 : 112);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`reply-${width}-${theme}.png`) });
        await expect(reply.locator(".reply-inline")).toBeVisible();
        await expect(reply.locator(".reply-metadata")).toContainText("回复布局助手");
        await expect(reply.locator(".reply-timestamp")).toBeVisible();
        const usage = reply.getByRole("button", { name: "查看生成用量" });
        await expect(usage).toContainText("缓存 8（73%）");
        await expect(usage).toHaveText(/\d+\.\ds$/);
        await expect(usage).not.toHaveText(/\d\s+s$/);
        await expect(reply.getByRole("button", { name: "复制回答", exact: true })).toBeVisible();
        await expect(reply.getByRole("button", { name: "重试", exact: true })).toBeVisible();
        await expect(reply.getByRole("button", { name: "消息更多操作" })).toHaveCount(0);
        await reply.getByRole("button", { name: "复制回答", exact: true }).focus();
        await page.mouse.move(0, 0);
        expect(await reply.boundingBox()).toEqual(before);
        await page.getByLabel("输入消息").focus();
      }
    }
    await reply.locator(".process-disclosure > summary").click();
    await expect(reply.getByText("先想一下。")).toBeVisible();
    await expect(reply.getByText("推理过程", { exact: true })).toHaveCount(1);
    await reply.locator(".process-disclosure > summary").click();
    await openMessageActions(page, reply);
    await page.getByRole("button", { name: "检查生成", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "检查器" });
    await expect(inspector).toContainText("回复布局助手");
    await expect(inspector).toContainText("18 tokens");
    await expect(inspector).toContainText("8 tokens（73%）");
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${started.conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});

test("用户消息重试对应历史回答，防止重复提交并保留草稿", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: "重试测试回答" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "User retry", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("重试助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "第一轮" });
  const id = started.conversation.id;
  const messages = (): Promise<MessageDto[]> => api(request, APP_URL, "GET", `/api/conversations/${id}/messages`);
  try {
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
    const second = await api(request, APP_URL, "POST", `/api/conversations/${id}/messages`, { text: "第二轮" });
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${second.generationId}`)).status).toBe("completed");
    await page.goto(`${APP_URL}/c/${id}`);
    const draft = page.getByLabel("输入消息");
    await draft.fill("尚未发送的草稿");
    const firstUser = page.locator('.msg[data-role="user"]').filter({ hasText: "第一轮" });
    const retry = firstUser.getByRole("button", { name: "重试回答", exact: true });
    const route = `**/api/messages/${started.generation.assistantMessageId}/generations`;
    await page.route(route, (intercept) => intercept.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conversation_busy", message: "重试暂不可用" } }) }), { times: 1 });
    await retry.click();
    await expect(page.locator(".toast.error").filter({ hasText: "重试暂不可用" })).toBeVisible();
    await expect(draft).toHaveValue("尚未发送的草稿");
    await expect(retry).toBeEnabled();
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(route, async (intercept) => { requests++; await pending; await intercept.continue(); });
    try {
      await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => requests).toBe(1);
      await expect(retry).toBeDisabled();
      await expect(page.locator('.msg[data-role="assistant"]').last().getByRole("button", { name: "重试", exact: true })).toBeDisabled();
    } finally { release(); }
    await expect.poll(async () => (await messages()).find((message) => message.id === started.generation.assistantMessageId)?.generations.length).toBe(2);
    await expect(retry).toBeEnabled();
    const after = await messages();
    expect(after.find((message) => message.id === second.assistantMessageId)?.generations).toHaveLength(1);
    expect(after.find((message) => message.id === started.generation.assistantMessageId)?.generations.some((generation) => generation.id === started.generation.generationId)).toBe(true);
    expect(requests).toBe(1);
    await expect(draft).toHaveValue("尚未发送的草稿");
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});
