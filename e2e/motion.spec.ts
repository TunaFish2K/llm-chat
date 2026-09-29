import { test, expect } from "./fixtures";
import { api, APP_URL, agentInput } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("对话框完成退场才卸载并恢复焦点，减少动态效果时直接关闭", async ({ page }) => {
  await page.goto(`${APP_URL}/agents`);
  const trigger = page.getByRole("button", { name: "新建 Agent", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建 Agent" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("transform", "none");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("手机抽屉短拖回弹、取消恢复、滑动关闭且不误选会话", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "手机触摸交互");
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`motion-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  await page.goto(`${APP_URL}/c/${conversation.id}`);
  const original = page.url();
  const touch = await page.context().newCDPSession(page);
  const drawer = page.locator(".drawer-panel");
  await page.getByRole("button", { name: "打开导航", exact: true }).tap();
  await expect(drawer).toHaveCSS("transform", "none");
  const swipe = async (distance: number, cancel = false) => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 250, y: 400 }] });
    for (let i = 1; i <= 10; i++) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 250 - distance * i / 10, y: 400 }] });
      await page.waitForTimeout(20);
    }
    await expect(drawer).not.toHaveCSS("transform", "none");
    await touch.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  };
  await swipe(30);
  await expect(drawer).toHaveCSS("transform", "none");
  await expect(page).toHaveURL(original);
  await swipe(100, true);
  await expect(drawer).toHaveCSS("transform", "none");
  await swipe(150);
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(original);
  await touch.detach();
});

test("历史消息不入场，流式新消息只入场一次，手动展开恢复自然高度", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: "动画测试回复" });
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "motion", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`motion-chat-${Date.now()}`, model.id));
    const first = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "历史消息" });
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${first.generation.generationId}`)).status).toBe("completed");
    await page.goto(`${APP_URL}/c/${first.conversation.id}`);
    await expect(page.locator('.msg[data-role="assistant"]')).toContainText("动画测试回复");
    await expect(page.locator(".msg[data-enter]")).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).__entrances = 0;
      document.addEventListener("animationstart", event => { if ((event as AnimationEvent).animationName === "message-enter") (window as any).__entrances++; });
    });
    await page.getByLabel("输入消息").fill("新增消息");
    await page.locator(".send-button").click();
    await expect(page.locator('.msg[data-role="assistant"]')).toHaveCount(2);
    await expect(page.locator('.msg[data-role="assistant"]').last()).toContainText("动画测试回复");
    await expect(page.locator(".msg[data-enter]")).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => (window as any).__entrances)).toBe(2);
    const disclosure = page.locator('.msg[data-role="assistant"]').last().locator(".process-disclosure");
    const summary = disclosure.locator(":scope > summary");
    await expect(summary).toBeVisible();
    if (await summary.getAttribute("aria-expanded") === "true") await summary.click();
    await expect(disclosure).not.toHaveAttribute("open");
    await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => disclosure.locator(":scope > .disclosure-body").evaluate(el => (el as HTMLElement).style.height)).toBe("");
    await page.reload();
    await expect(page.locator(".msg")).toHaveCount(4);
    await expect(page.locator(".msg[data-enter]")).toHaveCount(0);
  } finally { await provider.close(); }
});
