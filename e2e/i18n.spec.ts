import { expect, test } from "./fixtures";
import { api, APP_URL, AUTH_URL } from "./helpers.mjs";

test.use({ locale: "en-US" });

test("English UI preserves drafts, validates paths, synchronizes tabs, and switches offline", async ({ page, context, request }) => {
  await page.goto("/settings/general");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const language = page.getByLabel("Language", { exact: true });
  await expect(language).toHaveValue("system");
  await page.getByRole("button", { name: "Choose working directory", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose working directory" });
  const path = dialog.getByRole("textbox", { name: "Directory path", exact: true });
  await expect(path).not.toBeFocused();
  await path.fill("relative/path");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("must be absolute");
  await expect(dialog.getByRole("button", { name: "Use this directory" })).toBeDisabled();
  await path.fill("/does-not-exist-chat-i18n");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Directory not found");
  if (test.info().project.name === "mobile-chromium") await expect(path).not.toBeFocused();
  await path.fill("/");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use this directory" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  const settings = await api(request, APP_URL, "GET", "/api/settings");
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: settings.defaultAgentId });
  try {
    await page.goto(`/c/${conversation.id}`);
    const composer = page.locator(".composer textarea").first();
    await composer.fill("保留中文草稿 / keep this draft");
    const second = await context.newPage();
    await second.goto("/settings/general");
    await second.getByLabel("Language", { exact: true }).selectOption("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(composer).toHaveValue("保留中文草稿 / keep this draft");
    await second.getByLabel("界面语言", { exact: true }).selectOption("en-US");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(composer).toHaveValue("保留中文草稿 / keep this draft");
    await second.reload();
    await expect(second.getByLabel("Language", { exact: true })).toHaveValue("en-US");
    await context.setOffline(true);
    await second.getByLabel("Language", { exact: true }).selectOption("zh-CN");
    await expect(second.getByRole("tab", { name: "通用", exact: true })).toBeVisible();
    await second.getByLabel("界面语言", { exact: true }).selectOption("en-US");
    await expect(second.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await expect(second.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.en-US.webmanifest");
    await context.setOffline(false);
    await second.close();
  } finally {
    await context.setOffline(false);
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
  }
});

test("login language switching preserves password and translates an existing error", async ({ page }) => {
  await page.goto(AUTH_URL!);
  await page.getByLabel("Access password", { exact: true }).fill("incorrect-i18n-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect password");
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(page.getByLabel("访问密码")).toHaveValue("incorrect-i18n-password");
  await expect(page.getByRole("alert")).toContainText("密码错误");
  await page.getByLabel("界面语言", { exact: true }).selectOption("en-US");
  await expect(page.getByRole("alert")).toContainText("Incorrect password");
});
