import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("首条消息跳转及上翻后再次发送都保持底部", async ({ page, request }) => {
  const provider = await startMockProvider({
    responseText: Array.from({ length: 35 }, (_, i) => `滚动回答第 ${i + 1} 段。`).join("\n\n")
  });
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Send scroll", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("发送滚动测试", model.id));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await api(request, APP_URL, "PATCH", "/api/settings", { lastAgentId: agent.id, lastWorkspacePath: null });
    await page.goto(APP_URL!);
    const input = page.getByLabel("输入消息", { exact: true });
    const outer = page.getByLabel("消息列表", { exact: true });
    const gap = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop;
    await input.fill("首条长消息。\n".repeat(60));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page).toHaveURL(/\/c\//);
    await expect(outer).toContainText("滚动回答第 35 段。");
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    expect(await outer.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);

    let intercepted = false;
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (route.request().method() === "POST") {
        intercepted = true;
        await pending;
      }
      await route.continue();
    });
    await input.fill("继续发送。\n".repeat(8));
    if (test.info().project.name === "mobile-chromium") {
      const bounds = (await outer.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      const x = bounds.x + bounds.width / 2;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: bounds.y + 40 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: bounds.y + 180 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
    } else {
      await outer.hover();
      await page.mouse.wheel(0, -500);
    }
    await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
    const send = page.getByRole("button", { name: "发送", exact: true });
    if (test.info().project.name === "mobile-chromium") await send.tap();
    else await send.click();
    await expect.poll(() => intercepted).toBe(true);
    // The server has not received the message yet; sending already restored follow.
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
    release();
    await expect(input).toHaveValue("");
    await expect.poll(() => provider.requests.length).toBe(2);
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await page.goto("about:blank");
    const conversations = await api(request, APP_URL, "GET", "/api/conversations");
    for (const conversation of conversations.filter((item: { agentId: string }) => item.agentId === agent.id)) {
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/messages`);
      for (const message of messages) for (const generation of message.generations) {
        if (["queued", "running", "waiting-approval"].includes(generation.status)) {
          await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
        }
      }
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    }
    await api(request, APP_URL, "PATCH", "/api/settings", { lastAgentId: original.lastAgentId, lastWorkspacePath: original.lastWorkspacePath });
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});
