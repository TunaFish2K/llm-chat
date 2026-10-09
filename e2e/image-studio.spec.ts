import { expect, test } from "./fixtures";
import { api, APP_URL, gotoPath } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.describe("独立绘图工作区", () => {
  test("附件入口直接唤起原生选择器，并保留绘图版本时间线", async ({ page, request }) => {
    const provider = await startMockProvider();
    let sessionId: string | null = null;
    try {
      const connection = await api(request, APP_URL, "POST", "/api/connections", {
        name: "Image Studio E2E",
        providerId: "openai",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "test-key",
        secretHeaders: {}
      });
      const model = await api(request, APP_URL, "POST", "/api/models", {
        connectionId: connection.id,
        modelKey: "gpt-image-e2e",
        displayName: "绘图 E2E",
        contextWindow: null,
        maxOutputTokens: 4096,
        imageProtocol: "openai-images",
        capabilities: {
          imageInput: false, imageOutput: true, imageEdit: true, imageMultiple: true,
          tools: false, temperature: false, topP: false, reasoning: false,
          reasoningSummary: false, adaptiveThinking: false, manualThinking: false
        },
        defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} },
        enabled: true
      });

      await gotoPath(page, "/");
      const chatImageInput = page.locator('.composer-native-files input[type="file"][accept*="image/png"]');
      await expect(chatImageInput).toHaveCount(1);
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 });
      await chatImageInput.click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles([]);

      await page.getByRole("link", { name: /打开绘图工作区/ }).click();
      await expect(page).toHaveURL(/\/images$/);
      await page.getByLabel("图片模型").selectOption(model.id);
      await page.getByLabel("画面描述").fill("雨后的未来图书馆");
      await page.getByRole("button", { name: "生成图片" }).click();
      await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/);
      sessionId = page.url().split("/").at(-1)!;
      await expect.poll(() => provider.requests.filter((entry: { kind?: string }) => entry.kind === "image").length).toBe(1);
      await expect(page.getByText("生成完成")).toBeVisible();
      await expect(page.locator(".image-result-grid img")).toHaveCount(1);

      await page.getByRole("button", { name: "重新生成" }).click();
      await expect(page.getByText("2/2")).toBeVisible();
      await expect(page.getByText("生成完成")).toBeVisible();
      await expect.poll(() => provider.requests.filter((entry: { kind?: string }) => entry.kind === "image").length).toBe(2);
    } finally {
      if (sessionId) await api(request, APP_URL, "DELETE", `/api/image-sessions/${sessionId}`).catch(() => {});
      await provider.close();
    }
  });
});
