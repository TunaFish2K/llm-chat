import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const locale of ["zh-CN", "en-US"] as const) {
 test.describe(locale, () => {
  test.use({ locale });
  test("manual native levels work in every editor and reach the provider unchanged", async ({ page, request }) => {
    const cn = locale === "zh-CN";
    const provider = await startMockProvider();
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Universal reasoning", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = await api(request, APP_URL, "POST", "/api/models", {
      connectionId: connection.id, modelKey: "custom-native", displayName: "Universal model", contextWindow: 128000, maxOutputTokens: 4096,
      capabilities: { reasoning: true }, defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true
    });
    const input = agentInput("Universal agent", model.id);
    const agent = await api(request, APP_URL, "POST", "/api/agents", { ...input, execution: { ...input.execution, reasoningSelection: { mode: "default" } } });
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    try {
      await page.goto(`/c/${conversation.id}`);
      await page.locator(".reasoning-trigger").click();
      await expect(page.locator(".reasoning-popover").getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".reasoning-popover").getByRole("slider")).toHaveAttribute("aria-valuetext", cn ? "默认" : "Default");
      await expect(page.locator(".reasoning-labels button")).toHaveCount(1);
      await page.goto("/settings/connections");
      await page.locator("tr").filter({ hasText: "Universal model" }).getByRole("button", { name: cn ? "编辑" : "Edit", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel(cn ? "推理档位来源" : "Reasoning levels source").selectOption("manual");
      await dialog.getByLabel(cn ? "原生推理档位" : "Native reasoning levels").fill("minimal\nnone\ndefault\nminimal");
      await dialog.getByRole("button", { name: cn ? "保存" : "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect((await api(request, APP_URL, "GET", "/api/models")).find((m: { id: string }) => m.id === model.id).reasoningEffortsOverride).toEqual(["minimal", "none", "default"]);
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      let levels = page.getByLabel(cn ? "推理档位" : "Reasoning levels", { exact: true });
      await expect(levels.locator("option")).toHaveText([cn ? "默认" : "Default", "minimal", "none", "default"]);
      await levels.selectOption("effort:minimal");
      await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
      await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
      await page.goto(`/c/${conversation.id}`);
      await page.locator(".composer-settings-trigger").click();
      await page.locator("[data-execution-settings]").click();
      dialog = page.getByRole("dialog");
      levels = dialog.getByLabel(cn ? "推理档位" : "Reasoning levels", { exact: true });
      await expect(levels.locator("option")).toHaveText([cn ? "跟随 Agent · minimal" : "Follow Agent · minimal", cn ? "默认" : "Default", "minimal", "none", "default"]);
      await levels.selectOption("effort:none");
      await dialog.getByRole("button", { name: cn ? "保存" : "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.locator(".composer textarea").first().fill("Native none");
      await page.getByRole("button", { name: cn ? "发送" : "Send", exact: true }).click();
      await expect.poll(() => provider.requests.length).toBe(1);
      expect(provider.requests[0].reasoning_effort).toBe("none");
      await expect(page.locator(".composer-stop-button")).toHaveCount(0);
      await page.locator(".reasoning-trigger").click();
      await page.locator(".reasoning-popover").getByRole("button", { name: cn ? "默认" : "Default", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.locator(".composer textarea").first().fill("Default");
      await page.getByRole("button", { name: cn ? "发送" : "Send", exact: true }).click();
      await expect.poll(() => provider.requests.length).toBe(2);
      expect(provider.requests[1]).not.toHaveProperty("reasoning_effort");
      await expect(page.locator(".composer-stop-button")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
      await provider.close();
    }
  });
 });
}
