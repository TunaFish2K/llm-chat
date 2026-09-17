import { expect, test, type Page } from "./fixtures";
import { api, APP_URL, AUTH_URL, initialPassword } from "./helpers.mjs";

const displayKey = "llm-chat.display.v1";
const readDisplay = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), displayKey);

for (const labels of [
  { locale: "zh-CN", general: "通用", appearance: "外观", interaction: "交互", theme: "主题", fontSize: "字号", reasoning: "推理块折叠策略", notifications: "会话通知", agent: "默认 Agent" },
  { locale: "en-US", general: "General", appearance: "Appearance", interaction: "Interaction", theme: "Theme", fontSize: "Font size", reasoning: "Reasoning collapse behavior", notifications: "Conversation notifications", agent: "Default Agent" }
]) {
  test(`设置栏目分类、深链接和历史导航（${labels.locale}）`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem("llm-chat.locale.v1", locale), labels.locale);
    await page.goto(`${APP_URL}/settings`);
    await expect(page.getByRole("tab", { name: labels.general, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel(labels.agent, { exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.theme, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(labels.notifications, { exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: labels.appearance, exact: true }).click();
    await expect(page).toHaveURL(`${APP_URL}/settings/appearance`);
    await expect(page.getByLabel(labels.theme, { exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: labels.fontSize, exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.reasoning, { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: labels.interaction, exact: true }).click();
    await expect(page).toHaveURL(`${APP_URL}/settings/interaction`);
    await expect(page.getByLabel(labels.reasoning, { exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.notifications, { exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.theme, { exact: true })).toHaveCount(0);

    await page.goBack();
    await expect(page.getByRole("tab", { name: labels.appearance, exact: true })).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page.getByRole("tab", { name: labels.interaction, exact: true })).toHaveAttribute("aria-selected", "true");
    for (const section of ["appearance", "interaction"] as const) {
      await page.goto(`${APP_URL}/settings/${section}`);
      await page.reload();
      await expect(page.getByRole("tab", { name: labels[section], exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test("显示偏好一次迁移、客户端隔离、同浏览器共享，离线重连不覆盖", async ({ page, context, browser, request }) => {
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const seed = {
    theme: "dark", accentColor: null, amoled: false, sidebarCollapsed: false,
    reasoningCollapsePolicy: "collapse-on-answer", generationHaptics: true
  };
  const { theme, ...uiPreferences } = seed;
  const server = await api(request, APP_URL, "PATCH", "/api/settings", { theme, uiPreferences });
  // Share authentication only; a second browser must not inherit localStorage.
  const other = await browser.newContext({ storageState: { cookies: (await context.storageState()).cookies, origins: [] } });
  await other.addInitScript(() => localStorage.setItem("llm-chat.quick-tour.v1", "seen"));
  const writes: string[] = [];
  context.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postData() ?? "");
  });
  try {
    await page.goto(`${APP_URL}/settings/appearance`);
    await expect(page.getByLabel("主题", { exact: true })).toHaveValue("dark");
    expect(await readDisplay(page)).toEqual(seed);
    const second = await context.newPage();
    const independent = await other.newPage();
    await second.goto(`${APP_URL}/settings/appearance`);
    await independent.goto(`${APP_URL}/settings/appearance`);
    await expect(independent.getByLabel("主题", { exact: true })).toHaveValue("dark");

    await page.getByLabel("主题", { exact: true }).selectOption("light");
    await page.getByRole("button", { name: "蓝色", exact: true }).click();
    await page.getByLabel("深色模式使用纯黑背景").check();
    await page.getByRole("tab", { name: "交互", exact: true }).click();
    await page.getByLabel("默认折叠侧边栏").check();
    await page.getByRole("checkbox", { name: /生成时振动/ }).uncheck();
    await page.getByLabel("推理块折叠策略").selectOption("never-auto-collapse");
    const chosen = { theme: "light", accentColor: "#018EEE", amoled: true, sidebarCollapsed: true,
      reasoningCollapsePolicy: "never-auto-collapse", generationHaptics: false };
    await expect.poll(() => readDisplay(second)).toEqual(chosen);
    await expect(second.getByLabel("主题", { exact: true })).toHaveValue("light");
    await second.getByRole("tab", { name: "交互", exact: true }).click();
    await expect(second.getByRole("checkbox", { name: /生成时振动/ })).not.toBeChecked();
    await expect(second.getByLabel("推理块折叠策略")).toHaveValue("never-auto-collapse");
    await expect(second.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(independent.getByLabel("主题", { exact: true })).toHaveValue("dark");
    expect(await readDisplay(independent)).toEqual(seed);
    expect(await api(request, APP_URL, "GET", "/api/settings")).toEqual(server);

    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page.reload();
    await expect(page.getByLabel("主题", { exact: true })).toHaveValue("light");
    if (test.info().project.name !== "mobile-chromium") {
      await expect(page.locator(".workspace-sidebar[data-compact]")).toBeVisible();
    }
    await second.getByRole("tab", { name: "通用", exact: true }).click();
    await expect(second.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
    await context.setOffline(true);
    await expect(second.getByLabel("默认 Agent", { exact: true })).toBeDisabled();
    await second.getByRole("tab", { name: "外观", exact: true }).click();
    await second.getByLabel("主题", { exact: true }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-amoled", "true");
    await expect(second.locator("html")).toHaveAttribute("data-amoled", "true");
    await second.getByRole("tab", { name: "交互", exact: true }).click();
    await second.getByLabel("推理块折叠策略").selectOption("always-collapsed");
    await expect.poll(() => readDisplay(page)).toMatchObject({ reasoningCollapsePolicy: "always-collapsed" });
    await second.getByLabel("推理块折叠策略").selectOption("never-auto-collapse");
    await second.getByRole("tab", { name: "通用", exact: true }).click();
    await context.setOffline(false);
    await expect(second.getByLabel("默认 Agent", { exact: true })).toBeEnabled();

    const refreshed = second.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings" && response.request().method() === "GET");
    await api(request, APP_URL, "PATCH", "/api/settings", { theme: "light", uiPreferences: { generationHaptics: true, amoled: false } });
    await refreshed;
    await second.getByRole("tab", { name: "交互", exact: true }).click();
    await expect(second.locator("html")).toHaveAttribute("data-amoled", "true");
    await expect(second.getByRole("checkbox", { name: /生成时振动/ })).not.toBeChecked();
    await page.reload();
    await expect(page.getByLabel("主题", { exact: true })).toHaveValue("dark");
    expect(await readDisplay(page)).toEqual({ ...chosen, theme: "dark" });
    expect(await readDisplay(independent)).toEqual(seed);
    expect(writes).toEqual([]);
    await second.close();
  } finally {
    await context.setOffline(false);
    await other.close();
    await api(request, APP_URL, "PATCH", "/api/settings", { theme: original.theme, uiPreferences: original.uiPreferences });
  }
});

test("显示偏好在退出、登录页刷新和重新登录后保留", async ({ page }) => {
  await page.goto(`${AUTH_URL}/settings/appearance`);
  await page.getByLabel("访问密码").fill(initialPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByLabel("主题", { exact: true })).toBeVisible();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "蓝色", exact: true }).click();
  await page.getByRole("tab", { name: "交互", exact: true }).click();
  await page.getByRole("checkbox", { name: /生成时振动/ }).uncheck();
  const chosen = await readDisplay(page);
  await page.goto(`${AUTH_URL}/settings/security`);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByLabel("访问密码")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("访问密码")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await readDisplay(page)).toEqual(chosen);
  await page.getByLabel("访问密码").fill(initialPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".app-frame")).toBeVisible();
  await page.goto(`${AUTH_URL}/settings/appearance`);
  await expect(page.getByLabel("主题", { exact: true })).toHaveValue("light");
  await page.getByRole("tab", { name: "交互", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /生成时振动/ })).not.toBeChecked();
  expect(await readDisplay(page)).toEqual(chosen);
});
