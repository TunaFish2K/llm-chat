import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  const cn = locale === "zh-CN";
  test("shares highlighted model search between Agent settings and the composer", async ({ page, request }) => {
    const connection = await api(request, APP_URL, "POST", "/api/connections", {
      name: "Picker cloud", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", secretHeaders: {}
    });
    const create = (name: string, key: string, vision: boolean, enabled = true) => api(request, APP_URL, "POST", "/api/models", {
      connectionId: connection.id, modelKey: key, displayName: name, contextWindow: 128000, maxOutputTokens: 4096,
      protocol: "openai-responses", capabilities: { imageInput: vision, imageOutput: vision, tools: true, reasoning: true },
      defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled
    });
    const plain = await create("Plain text model", "plain-text", false);
    const vision = await create("Vision vision 模型 " + "long name ".repeat(12), "vision.*[test]", true);
    await create("Disabled vision", "disabled-vision", true, false);
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Picker Agent"));
    let conversationId: string | undefined;
    const modelLabel = cn ? "模型" : "Model";
    const visionLabel = cn ? "备用识图模型" : "Fallback vision model";
    const panel = page.locator(".model-picker-popover");
    const rows = panel.locator(".model-group .model-option");
    const search = panel.getByRole("searchbox");
    const save = async () => {
      await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
      await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
    };
    const checkSearch = async () => {
      for (const [query, selector, expected] of [
        [" VISION ", "strong mark", ["Vision", "vision"]],
        [".*[test]", "small mark", [".*[test]"]],
        ["PICKER", "h3 mark", ["Picker"]],
        ["RESPONSES", "small mark", ["responses"]]
      ] as const) {
        await search.fill(query);
        const highlights = await panel.locator(selector).allTextContents();
        expect(highlights.length).toBeGreaterThan(0);
        for (const text of expected) expect(highlights).toContain(text);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const rect = await panel.boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
    };
    try {
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      const defaultTrigger = page.getByRole("button", { name: modelLabel, exact: true });
      const visionTrigger = page.getByRole("button", { name: visionLabel, exact: true });
      await defaultTrigger.click();
      if (test.info().project.name === "mobile-chromium") await expect(search).not.toBeFocused();
      else await expect(search).toBeFocused();
      await expect(rows).toHaveCount(2);
      await checkSearch();
      await search.fill("Plain");
      await rows.first().click();
      await expect(defaultTrigger).toContainText(plain.displayName);
      expect((await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).execution.modelId).toBeNull();
      await visionTrigger.click();
      await expect(search).toHaveValue("");
      await expect(rows).toHaveCount(1);
      await checkSearch();
      await search.fill("vision");
      await page.screenshot({ animations: "disabled", path: test.info().outputPath("vision-picker-light.png") });
      await rows.first().click();
      expect((await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).execution.visionModelId).toBeNull();
      await save();
      await page.reload();
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      await expect(defaultTrigger).toContainText(plain.displayName);
      await expect(visionTrigger).toContainText(vision.displayName);
      await defaultTrigger.click();
      await search.fill("absent");
      await panel.getByRole("button", { name: cn ? "（不设默认模型）" : "(no default model)", exact: true }).click();
      await visionTrigger.click();
      await panel.getByRole("button", { name: cn ? "（未配置）" : "(not configured)", exact: true }).click();
      await save();
      const cleared = await api(request, APP_URL, "GET", `/api/agents/${agent.id}`);
      expect(cleared.execution.modelId).toBeNull();
      expect(cleared.execution.visionModelId).toBeNull();

      const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, executionOverrides: { modelId: plain.id } });
      conversationId = conversation.id;
      await page.goto(`/c/${conversation.id}`);
      await page.getByRole("button", { name: cn ? "选择模型" : "Select model", exact: true }).click();
      await checkSearch();
      await search.fill("vision");
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.screenshot({ animations: "disabled", path: test.info().outputPath("composer-picker-dark.png") });
      await rows.first().click();
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).modelId).toBe(vision.id);
      await page.getByRole("button", { name: cn ? "选择模型" : "Select model", exact: true }).click();
      await expect(search).toHaveValue("");
      await search.fill("cloud");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await page.getByRole("button", { name: cn ? "选择模型" : "Select model", exact: true }).click();
      await expect(search).toHaveValue("");
      await panel.getByRole("button", { name: cn ? /跟随 Agent/ : /Follow Agent/ }).click();
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.modelId).toBeUndefined();
    } finally {
      await page.goto("about:blank");
      if (conversationId) await api(request, APP_URL, "DELETE", `/api/conversations/${conversationId}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    }
  });
});
