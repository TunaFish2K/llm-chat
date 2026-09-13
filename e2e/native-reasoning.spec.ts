import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

for (const locale of ["zh-CN", "en-US"] as const) {
 test.describe(locale, () => {
  test.use({ locale, serviceWorkers: "block" });
  test("native effort sliders silently adapt inheritance and preserve the message draft", async ({ page, request }) => {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: `Native ${locale}`, protocol: "openai-responses", baseUrl: "https://example.invalid/v1", secretHeaders: {} });
    const model = await api(request, APP_URL, "POST", "/api/models", {
      connectionId: connection.id, modelKey: "grok-4.6", displayName: "Native Grok", contextWindow: 128000, maxOutputTokens: 4096, reasoningEffortsOverride: ["low", "medium", "high", "xhigh"],
      capabilities: { reasoning: true }, defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true
    });
    const input = agentInput(`Native ${locale}`, model.id);
    input.execution.reasoningEffort = "max";
    const agent = await api(request, APP_URL, "POST", "/api/agents", input);
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    try {
      await page.goto(`/c/${conversation.id}`);
      const composer = page.locator(".composer textarea").first();
      await composer.fill("Keep this draft");
      await page.locator(".reasoning-trigger").click();
      const popover = page.locator(".reasoning-popover");
      await expect(popover.getByRole("alert")).toHaveCount(0);
      await expect(popover.getByRole("slider")).toHaveAttribute("aria-valuetext", "xhigh");
      await expect(popover.getByRole("checkbox")).toBeChecked();
      expect((await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toBeUndefined();
      await expect(popover.getByRole("button", { name: "max", exact: true })).toHaveCount(0);
      await expect(popover.getByRole("button").filter({ hasText: /^(low|medium|high|xhigh)$/ })).toHaveText(["xhigh", "high", "medium", "low"]);
      await expect(popover.getByRole("slider")).toHaveAttribute("aria-orientation", "vertical");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`native-effort-${locale}.png`) });
      await popover.getByRole("button", { name: "xhigh", exact: true }).click();
      await expect(composer).toHaveValue("Keep this draft");
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "xhigh" });
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: locale === "zh-CN" ? "执行配置" : "Execution settings", exact: true }).click();
      const levels = page.getByLabel(locale === "zh-CN" ? "推理档位" : "Reasoning levels", { exact: true });
      await expect(levels).toHaveValue("effort:xhigh");
      await expect(levels.locator('option[value="effort:max"]')).toHaveCount(0);
      expect((await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).execution.reasoningEffort).toBe("max");
      await expect(levels.locator("option:not(:disabled)")).toHaveText([locale === "zh-CN" ? "默认" : "Default", "low", "medium", "high", "xhigh"]);
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    }
  });
 });
}
