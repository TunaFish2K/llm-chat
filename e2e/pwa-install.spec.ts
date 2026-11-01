import { expect, test } from "./fixtures";
import { openDrawerIfNeeded } from "./helpers.mjs";

test.use({ serviceWorkers: "block" });

test("installs only from General settings and removes installation from both sidebars", async ({ page }, testInfo) => {
  await page.goto("/settings/general");
  const card = page.getByLabel("安装PWA", { exact: true });
  await expect(card.getByRole("heading", { name: "安装PWA" })).toBeVisible();
  await page.evaluate(() => {
    Object.assign(window, { installPromptCalls: 0 });
    const prompt = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => { (window as unknown as { installPromptCalls: number }).installPromptCalls++; },
      userChoice: Promise.resolve({ outcome: "dismissed" })
    });
    window.dispatchEvent(prompt);
  });
  await expect(card.getByRole("button", { name: "安装PWA" })).toBeVisible();
  await openDrawerIfNeeded(page);
  const sidebar = page.locator('.workspace-sidebar:visible:not([aria-hidden="true"]):not([inert])');
  await expect(sidebar.getByRole("button", { name: /安装/ })).toHaveCount(0);
  if (testInfo.project.name !== "mobile-chromium") {
    await sidebar.getByRole("button", { name: "折叠会话栏" }).click();
    await expect(sidebar).toHaveAttribute("data-compact", "true");
    await expect(sidebar.getByRole("button", { name: /安装/ })).toHaveCount(0);
  } else await sidebar.getByRole("button", { name: "关闭导航" }).click();
  await card.getByRole("button", { name: "安装PWA" }).click();
  await expect(card.getByText(/在浏览器菜单中查找/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { installPromptCalls: number }).installPromptCalls)).toBe(1);
  await page.screenshot({ path: `/tmp/llm-ui-artifacts/pwa-install-${testInfo.project.name}.png` });
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(card.getByRole("status")).toHaveText("已安装");
  await page.goto("/images");
  await openDrawerIfNeeded(page);
  await expect(page.locator(".workspace-sidebar:visible").getByRole("button", { name: /安装/ })).toHaveCount(0);
});

test("recognizes an installed app opened in standalone mode", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => query === "(display-mode: standalone)"
      ? Object.defineProperty(original(query), "matches", { value: true }) : original(query);
  });
  await page.goto("/settings/general");
  const card = page.getByLabel("安装PWA", { exact: true });
  await expect(card.getByRole("status")).toHaveText("已安装");
  await expect(card.getByRole("button")).toHaveCount(0);
});
