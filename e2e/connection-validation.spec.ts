import { expect, test } from "./fixtures";
import { api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  test("explains an invalid API key before saving and accepts a corrected key", async ({ page, request }) => {
    const cn = locale === "zh-CN";
    const provider = await startMockProvider();
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Key validation", protocol: "openai-responses", baseUrl: provider.baseUrl, apiKey: "initial-test-key", secretHeaders: {} });
    const updates: string[] = [];
    page.on("request", req => { if (req.method() === "PATCH" && req.url().endsWith(`/api/connections/${connection.id}`)) updates.push(req.url()); });
    try {
      await page.goto("/settings/connections");
      await page.locator(".card").filter({ has: page.getByRole("heading", { name: /Key validation/ }) }).getByRole("button", { name: cn ? "编辑" : "Edit", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("API Key", { exact: true }).fill("test-使用说明-private");
      await dialog.getByRole("button", { name: cn ? "保存" : "Save", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText(cn ? "API Key 含有无效字符" : "The API key contains invalid characters");
      expect(updates).toHaveLength(0);
      await dialog.getByLabel("API Key", { exact: true }).fill("corrected-test-key");
      await dialog.getByRole("button", { name: cn ? "保存" : "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(updates).toHaveLength(1);
      expect(await api(request, APP_URL, "POST", `/api/connections/${connection.id}/test`)).toEqual({ ok: true, modelsFound: 1 });
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
      await provider.close();
    }
  });
});
