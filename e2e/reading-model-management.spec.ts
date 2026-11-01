import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, discoverEnabledModels } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.use({ serviceWorkers: "block" });

test("reading uses the whole small window, keeps drafts and exits without visible controls", async ({ page, request }, testInfo) => {
  const provider = await startMockProvider({ responseText: Array.from({ length: 40 }, (_, i) => `阅读段落 ${i + 1}。这段内容用于核对阅读位置与窗口空间。`).join("\n\n") });
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Reading", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await discoverEnabledModels(request, APP_URL, connection.id)).created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("阅读测试", model.id));
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    const generation = await api(request, APP_URL, "POST", `/api/conversations/${conversation.id}/messages`, { text: "阅读测试" });
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${generation.generationId}`)).status).toBe("completed");
    const mobile = testInfo.project.name === "mobile-chromium";
    if (!mobile) await page.setViewportSize({ width: 900, height: 520 });
    await page.goto(`/c/${conversation.id}`);
    const input = page.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("阅读期间保留的草稿");
    const paragraph = page.getByText("阅读段落 15。这段内容用于核对阅读位置与窗口空间。", { exact: true });
    await paragraph.scrollIntoViewIfNeeded();
    const scroll = page.locator(".chat-scroll");
    await scroll.evaluate(element => { element.scrollTop += 100; });
    const before = (await paragraph.boundingBox())!.y - (await scroll.boundingBox())!.y;
    await page.getByRole("button", { name: "阅读模式", exact: true }).click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-reading", "true");
    await expect(page.locator(".composer")).toBeHidden();
    await expect(page.locator(".conversation-header")).toBeHidden();
    await expect(page.locator(".workspace-sidebar")).toBeHidden();
    await expect.poll(async () => (await scroll.boundingBox())!.height).toBeGreaterThan((page.viewportSize()!.height) - 2);
    await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - (await scroll.boundingBox())!.y - before)).toBeLessThan(8);
    await expect(page.locator(".app-frame[data-reading] .stream-actions:visible")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/llm-ui-artifacts/reading-${testInfo.project.name}.png` });
    if (mobile) {
      const box = (await scroll.boundingBox())!;
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 250, y: box.y + 180 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 140, y: box.y + 180 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    } else await page.keyboard.press("q");
    await expect(page.locator(".app-frame")).not.toHaveAttribute("data-reading");
    await expect(input).toHaveValue("阅读期间保留的草稿");
    await expect(input).not.toBeFocused();
    await page.getByRole("button", { name: "阅读模式", exact: true }).click();
    if (mobile) {
      // Whitespace within the scroll surface avoids native text selection.
      const box = (await scroll.boundingBox())!;
      await page.touchscreen.tap(box.x + 3, box.y + 100);
      await page.touchscreen.tap(box.x + 3, box.y + 100);
    } else await page.keyboard.press("Escape");
    await expect(page.locator(".app-frame")).not.toHaveAttribute("data-reading");
  } finally { await provider.close(); }
});

test("new discoveries are disabled and filtered selection enables just the chosen models", async ({ page, request }, testInfo) => {
  const provider = await startMockProvider();
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "批量筛选提供商", baseUrl: provider.baseUrl, secretHeaders: {} });
    await page.goto("/settings/connections");
    await page.getByRole("combobox", { name: "提供商连接" }).selectOption(connection.id);
    await page.getByRole("button", { name: "发现模型", exact: true }).click();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/models?connectionId=${connection.id}`)).length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "发现模型", exact: true })).toBeEnabled();
    const discovered = { created: await api(request, APP_URL, "GET", `/api/models?connectionId=${connection.id}`) };
    expect(discovered.created.every((model: { enabled: boolean }) => !model.enabled)).toBe(true);
    await page.getByRole("combobox", { name: "启用状态" }).selectOption("disabled");
    await page.getByRole("checkbox", { name: "全选筛选结果" }).check();
    await page.getByRole("button", { name: `启用 ${discovered.created.length}`, exact: true }).click();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/models?connectionId=${connection.id}`)).every((model: { enabled: boolean }) => model.enabled)).toBe(true);
    await page.getByRole("combobox", { name: "启用状态" }).selectOption("enabled");
    await page.getByRole("button", { name: "反选", exact: true }).click();
    await expect(page.getByRole("button", { name: `禁用 ${discovered.created.length}`, exact: true })).toBeEnabled();
    await page.screenshot({ path: `/tmp/llm-ui-artifacts/models-${testInfo.project.name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const again = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
    expect(again.created).toHaveLength(0);
    expect((await api(request, APP_URL, "GET", `/api/models?connectionId=${connection.id}`)).every((model: { enabled: boolean }) => model.enabled)).toBe(true);
  } finally { await provider.close(); }
});
