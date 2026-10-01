import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { heavyHistory, heavyProfiles } from "./heavy-history";

const key = "llm-chat.animations.v1";
test.use({ serviceWorkers: "block" });

test("点击反馈按下立即呈现，释放按设置速度淡出", async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ feedback: .25 })), key);
  await page.goto(`${APP_URL}/settings/animations`);
  const tab = page.getByRole("tab", { name: "动画", exact: true });
  const bounds = (await tab.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(tab).toHaveAttribute("data-pressed", "true");
  const pressed = await tab.evaluate(element => getComputedStyle(element).boxShadow);
  await page.mouse.up();
  await expect(tab).toHaveAttribute("data-pressed", "releasing");
  await expect.poll(() => tab.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe(pressed);
  await expect(tab).not.toHaveAttribute("data-pressed");
});

for (const labels of [
  { locale: "zh-CN", title: "动画", sidebar: "侧栏", modal: "弹窗", reset: "恢复默认" },
  { locale: "en-US", title: "Animations", sidebar: "Sidebar", modal: "Dialogs", reset: "Restore defaults" }
]) {
  test(`动画设置独立、刷新恢复、跨标签页同步并支持离线修改（${labels.locale}）`, async ({ page, context }) => {
    await page.addInitScript(locale => localStorage.setItem("llm-chat.locale.v1", locale), labels.locale);
    const writes: string[] = [];
    page.on("request", request => { if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postData() ?? ""); });
    await page.goto(`${APP_URL}/settings/animations`);
    await expect(page.getByRole("tab", { name: labels.title, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("slider")).toHaveCount(10);
    const sidebar = page.getByRole("slider", { name: labels.sidebar, exact: true });
    await expect(sidebar).toHaveValue("1");
    await expect(sidebar).toHaveAttribute("aria-valuetext", "1× · 140 ms");
    await sidebar.press("End");
    await expect(sidebar).toHaveValue("3");
    await expect(page.getByRole("slider", { name: labels.modal, exact: true })).toHaveValue("1");
    await page.reload();
    await expect(sidebar).toHaveValue("3");
    const other = await context.newPage();
    try {
      await other.goto(`${APP_URL}/settings/animations`);
      await expect(other.getByRole("slider", { name: labels.sidebar, exact: true })).toHaveValue("3");
      await sidebar.press("Home");
      await expect(other.getByRole("slider", { name: labels.sidebar, exact: true })).toHaveValue("0");
      await context.setOffline(true);
      await sidebar.press("ArrowRight");
      await expect(sidebar).toHaveValue("0.25");
      await expect(sidebar).toHaveAttribute("aria-valuetext", "0.25× · 560 ms");
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).sidebar, key)).toBe(.25);
      await page.getByRole("button", { name: labels.reset, exact: true }).click();
      expect(await page.getByRole("slider").evaluateAll(elements => elements.every(element => (element as HTMLInputElement).value === "1"))).toBe(true);
      expect(writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.setOffline(false); await other.close(); }
  });
}

test("关闭弹窗与浮层动画后仍能关闭、恢复焦点并遵循系统减少动态效果", async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ modal: 0, popover: 0, loading: 0 }));
  }, key);
  await page.goto(`${APP_URL}/agents`);
  const trigger = page.getByRole("button", { name: "新建 Agent", exact: true });
  const dialog = page.getByRole("dialog", { name: "新建 Agent" });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("transform", "none");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goto(`${APP_URL}/settings/animations`);
  await page.getByRole("slider", { name: "弹窗", exact: true }).press("Home");
  await page.getByRole("slider", { name: "弹窗", exact: true }).press("ArrowRight");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${APP_URL}/agents`);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).modal, key)).toBe(.25);
  await trigger.click();
  await expect(dialog).toHaveCSS("transform", "none");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(APP_URL);
  const settings = page.getByRole("button", { name: "低频设置", exact: true });
  await settings.click();
  const popover = page.locator(".composer-settings-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveCSS("animation-duration", "0s");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(settings).toBeFocused();
});

test("桌面侧栏使用单独设置的时长，关闭动画后直接更新布局", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面布局动画");
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ sidebar: .25 })), key);
  await page.goto(`${APP_URL}/settings/animations`);
  await page.locator(".sidebar-collapse-button").click();
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.matches(".workspace-main");
  }).map(animation => animation.effect!.getTiming().duration))).toContain(560);
  await page.locator(".sidebar-brand-button").click();
  await page.getByRole("slider", { name: "侧栏", exact: true }).press("Home");
  await page.locator(".sidebar-collapse-button").click();
  expect(await page.evaluate(() => document.getAnimations().some(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.matches(".workspace-main, .workspace-sidebar");
  }))).toBe(false);
  await expect(page.locator('.workspace-sidebar[aria-hidden="true"]')).toHaveCount(0);
});

test("手机慢速侧栏退出期间保持可输入且不提前挂载重历史", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "手机抽屉退出与历史挂载");
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ sidebar: .25 })), key);
  const profile = heavyProfiles[0]!;
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("动画速度回归"));
  const heavy = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "慢速动画重历史" });
  const short = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  await page.route(`**/api/conversations/${heavy.id}/messages`, route => route.fulfill({ json: heavyHistory(profile) }));
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    await route.fulfill({ response, json: { ...await response.json(), messages: [] } });
  });
  await page.goto(`${APP_URL}/c/${short.id}`);
  await openDrawerIfNeeded(page);
  await page.evaluate(id => {
    const metrics = { premature: 0, frames: 0, finished: false };
    (window as any).__slowDrawer = metrics;
    const check = () => {
      const workspace = document.querySelector<HTMLElement>(".chat-workspace");
      if (workspace?.dataset.conversationId === id) {
        if (!document.querySelector(".mobile-drawer")) { metrics.finished = true; return; }
        metrics.frames++;
        if (workspace.querySelector(".msg")) metrics.premature++;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, heavy.id);
  await page.locator(`.conversation-row a[href="/c/${heavy.id}"]`).click();
  await page.waitForFunction(id => document.querySelector<HTMLElement>(".chat-workspace")?.dataset.conversationId === id && document.querySelector('.mobile-drawer[data-exiting]'), heavy.id);
  await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
  await expect(page.locator(".msg").last()).toContainText("最新回复");
  const metrics = await page.evaluate(() => (window as any).__slowDrawer);
  expect(metrics.finished).toBe(true);
  expect(metrics.frames).toBeGreaterThan(10);
  expect(metrics.premature).toBe(0);
});
