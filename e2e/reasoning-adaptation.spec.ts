import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const locale of ["zh-CN", "en-US"] as const) {
 test.describe(locale, () => {
  test.use({ locale });
  test("model switches keep the requested effort and send only the displayed supported level", async ({ page, request }) => {
    const provider = await startMockProvider();
    const connection = await api(request, APP_URL, "POST", "/api/connections", {
      name: "Adapt reasoning", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {}
    });
    const create = (name: string, levels: string[], reasoning = true) => api(request, APP_URL, "POST", "/api/models", {
      connectionId: connection.id, modelKey: name, displayName: name, contextWindow: 128000, maxOutputTokens: 4096,
      reasoningEffortsOverride: levels, capabilities: { reasoning },
      defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true
    });
    const full = await create("Full levels", ["low", "medium", "high", "max"]);
    const limited = await create("Limited levels", ["low", "xhigh"]);
    const plain = await create("Plain model", [], false);
    const input = agentInput("Adapt agent", full.id);
    const preference = { mode: "effort", value: "max" };
    const agent = await api(request, APP_URL, "POST", "/api/agents", {
      ...input, execution: { ...input.execution, reasoningSelection: preference }
    });
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", {
      agentId: agent.id, executionOverrides: { reasoningSelection: preference }
    });
    try {
      await page.goto(`/c/${conversation.id}`);
      const composer = page.locator(".composer textarea").first();
      for (const [index, entry] of [
        { model: limited, effective: "xhigh" }, { model: full, effective: "max" },
        { model: plain, effective: null }, { model: full, effective: "max" }
      ].entries()) {
        await composer.fill(`Keep draft ${index}`);
        await page.locator(".model-trigger").click();
        await page.locator(".model-group .model-option").filter({ hasText: entry.model.displayName }).click();
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).modelId).toBe(entry.model.id);
        await page.locator(".reasoning-trigger").click();
        const popover = page.locator(".reasoning-popover");
        const label = entry.effective ?? (locale === "zh-CN" ? "默认" : "Default");
        await expect(popover.getByRole("slider")).toHaveAttribute("aria-valuetext", label);
        await expect(popover.getByRole("alert")).toHaveCount(0);
        await expect(popover.getByRole("checkbox")).toHaveCount(0);
        await expect(popover.locator(".reasoning-labels button")).toHaveCount(entry.model.reasoningEffortsOverride.length + 1);
        expect((await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual(preference);
        await page.keyboard.press("Escape");
        await expect(composer).toHaveValue(`Keep draft ${index}`);
        await page.getByRole("button", { name: locale === "zh-CN" ? "发送" : "Send", exact: true }).click();
        await expect.poll(() => provider.requests.length).toBe(index + 1);
        if (entry.effective) expect(provider.requests[index].reasoning_effort).toBe(entry.effective);
        else expect(provider.requests[index]).not.toHaveProperty("reasoning_effort");
        await expect(page.locator(".composer-stop-button")).toHaveCount(0);
      }
      expect((await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).execution.reasoningSelection).toEqual(preference);
      await page.reload();
      await page.locator(".reasoning-trigger").click();
      await expect(page.locator(".reasoning-popover").getByRole("slider")).toHaveAttribute("aria-valuetext", "max");
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
