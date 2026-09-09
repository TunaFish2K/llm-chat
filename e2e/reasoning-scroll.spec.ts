import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("长推理展开后内外层跟随，手动上翻暂停并能恢复", async ({ page, request }) => {
  const provider = await startMockProvider({
    reasoningChunks: Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 步：继续推理，验证最新内容始终可读。\n`.repeat(3)),
    firstResponseDelayMs: 150,
    responseText: "推理结束，开始回答。"
  });
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Scroll test", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("滚动测试", model.id));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  try {
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: { reasoningCollapsePolicy: "always-collapsed" } });
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await page.getByLabel("输入消息", { exact: true }).fill("开始长推理");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const disclosure = page.locator(".process-disclosure").last();
    const inner = disclosure.getByRole("region", { name: "推理内容" });
    const outer = page.getByLabel("消息列表", { exact: true });
    const gap = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop;
    await expect(disclosure).toBeAttached();
    await expect(disclosure).not.toHaveAttribute("open");
    await disclosure.locator("summary").click();
    await expect(inner).toBeVisible();
    await expect.poll(() => inner.evaluate((element) => element.scrollHeight)).toBeGreaterThan(600);
    await expect.poll(() => inner.evaluate(gap)).toBeLessThan(2);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    expect(await inner.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(460);

    // Actual wheel input must stop following before the next streaming chunk arrives.
    if (test.info().project.name === "mobile-chromium") {
      const bounds = (await inner.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      const x = bounds.x + bounds.width / 2;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: bounds.y + 40 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: bounds.y + 200 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await inner.evaluate((element) => new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); element.removeEventListener("scrollend", done); resolve(); };
        const timer = setTimeout(done, 1000);
        element.addEventListener("scrollend", done, { once: true });
      }));
      await touch.detach();
    } else {
      await inner.hover();
      await page.mouse.wheel(0, -180);
    }
    await expect.poll(() => inner.evaluate(gap)).toBeGreaterThan(100);
    const position = await inner.evaluate((element) => element.scrollTop);
    const content = await inner.textContent();
    await expect.poll(() => inner.textContent()).not.toBe(content);
    expect(Math.abs((await inner.evaluate((element) => element.scrollTop)) - position)).toBeLessThan(2);
    await inner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => inner.evaluate(gap)).toBeLessThan(2);

    const resumedContent = await inner.textContent();
    await expect.poll(() => inner.textContent()).not.toBe(resumedContent);
    await expect.poll(() => inner.evaluate(gap)).toBeLessThan(2);

    // Give the outer page enough overflow even on a tall desktop viewport.
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 640 });
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await outer.evaluate((element) => { element.scrollTop = 0; });
    await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
    const outerTop = await outer.evaluate((element) => element.scrollTop);
    const previousContent = await inner.textContent();
    await expect.poll(() => inner.textContent()).not.toBe(previousContent);
    expect(await outer.evaluate((element) => element.scrollTop)).toBe(outerTop);
    await page.getByRole("button", { name: "回到最新消息" }).click();
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
    await expect(page.getByText("推理结束，开始回答。", { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    await expect(disclosure).toHaveAttribute("open");
    await expect.poll(() => inner.evaluate(gap)).toBeLessThan(2);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);

    // A completed reasoning block starts at the beginning on a fresh visit.
    await page.goto(APP_URL + "/settings/general");
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await disclosure.locator("summary").click();
    await expect(inner).toBeVisible();
    expect(await inner.evaluate((element) => element.scrollTop)).toBe(0);
    await inner.evaluate((element) => { element.scrollTop = 120; });
    await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBe(120);
    // DOM click avoids scrolling the summary into view and changing the outer reader position.
    await disclosure.locator("summary").evaluate((element: HTMLElement) => element.click());
    await expect(disclosure).not.toHaveAttribute("open");
    await disclosure.locator("summary").evaluate((element: HTMLElement) => element.click());
    await expect(inner).toBeVisible();
    expect(await inner.evaluate((element) => element.scrollTop)).toBe(120);
  } finally {
    await page.goto("about:blank");
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/messages`);
    for (const message of messages) for (const generation of message.generations) {
      if (["queued", "running", "waiting-approval"].includes(generation.status)) {
        await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
      }
    }
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: { reasoningCollapsePolicy: original.uiPreferences.reasoningCollapsePolicy } });
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});

test("自动收起推理后仍跟随正文，完成后展开也保持页面底部", async ({ page, request }) => {
  const provider = await startMockProvider({
    reasoningChunks: Array.from({ length: 30 }, (_, i) => `推理 ${i + 1}\n`.repeat(5)),
    firstResponseDelayMs: 100,
    responseText: "完整回答。\n\n".repeat(40)
  });
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Collapse test", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("自动收起测试", model.id));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  try {
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: { reasoningCollapsePolicy: "collapse-on-answer" } });
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await page.getByLabel("输入消息", { exact: true }).fill("开始");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const disclosure = page.locator(".process-disclosure").last();
    const outer = page.getByLabel("消息列表", { exact: true });
    const gap = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop;
    await expect(disclosure).toHaveAttribute("open");
    await expect.poll(() => disclosure.getByRole("region", { name: "推理内容" }).evaluate((element) => element.scrollHeight)).toBeGreaterThan(460);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(disclosure).not.toHaveAttribute("open", { timeout: 10_000 });
    await expect(page.locator(".composer-stop-button")).toHaveCount(0);
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
    // Opening a completed disclosure changes layout without changing message data.
    await disclosure.locator("summary").evaluate((element: HTMLElement) => element.click());
    await expect(disclosure).toHaveAttribute("open");
    await expect.poll(() => outer.evaluate(gap)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "PATCH", "/api/settings", { uiPreferences: { reasoningCollapsePolicy: original.uiPreferences.reasoningCollapsePolicy } });
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});
