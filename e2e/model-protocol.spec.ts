import { expect, test } from "./fixtures";
import { api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const locale of ["zh-CN", "en-US"] as const) {
 test.describe(locale, () => {
  test.use({ locale });
  test("model protocol edits preserve managed metadata and can return to automatic", async ({ page, request }) => {
   const provider = await startMockProvider();
   const connection = await api(request, APP_URL, "POST", "/api/connections", { name: `Protocol ${locale}`, providerId: "opencode-go", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
   try {
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    expect(model.catalogManaged).toBe(true);
    await page.goto("/settings/connections");
    const row = page.locator("tr").filter({ hasText: model.displayName }).filter({ hasText: "e2e-chat" });
    await row.getByRole("button", { name: locale === "zh-CN" ? "编辑" : "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const protocol = dialog.getByLabel(locale === "zh-CN" ? "模型协议" : "Model protocol", { exact: true });
    await expect(protocol).toHaveValue("");
    await expect(dialog).toContainText("openai-chat");
    await protocol.selectOption("openai-responses");
    await expect(dialog).toContainText("openai-responses");
    await dialog.getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await api(request, APP_URL, "GET", "/api/models")).find((m: { id: string }) => m.id === model.id);
    expect(saved).toMatchObject({ protocol: "openai-responses", catalogManaged: true, defaultSettings: model.defaultSettings, capabilities: model.capabilities });
    await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
    expect((await api(request, APP_URL, "GET", "/api/models")).find((m: { id: string }) => m.id === model.id).protocol).toBe("openai-responses");
    await row.getByRole("button", { name: locale === "zh-CN" ? "编辑" : "Edit", exact: true }).click();
    await protocol.selectOption("");
    await dialog.getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await api(request, APP_URL, "GET", "/api/models")).find((m: { id: string }) => m.id === model.id)).toMatchObject({ protocol: null, catalogManaged: true });
   } finally {
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
   }
  });
 });
}
