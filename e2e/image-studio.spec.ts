import { expect, test } from "./fixtures";
import { api, APP_URL, gotoPath } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test.describe("独立绘图工作区", () => {
  test("附件抽屉唤起原生选择器，绘图沿用聊天消息与发送栏", async ({ page, request }) => {
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
      // The paperclip drawer stays; its rows are labels for real, always-mounted file inputs.
      await page.locator(".composer-tools").getByRole("button", { name: "添加附件" }).click();
      const imageRow = page.getByRole("button", { name: "上传图片", exact: true });
      await expect(imageRow).toBeVisible();
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 });
      await imageRow.click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles([]);
      await page.keyboard.press("Escape");

      await page.getByRole("link", { name: /打开绘图工作区/ }).click();
      await expect(page).toHaveURL(/\/images$/);
      await page.getByRole("button", { name: "图片模型", exact: true }).click();
      await page.getByRole("button", { name: /绘图 E2E/ }).click();
      const prompt = page.getByLabel("画面描述");
      await prompt.fill("雨后的未来图书馆");
      await prompt.press("Enter");
      await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/);
      sessionId = page.url().split("/").at(-1)!;
      await expect(prompt).toHaveValue("");
      await expect.poll(() => provider.requests.filter((entry: { kind?: string }) => entry.kind === "image").length).toBe(1);
      await expect(page.locator(".msg[data-role=user] .msg-bubble")).toHaveText("雨后的未来图书馆");
      await expect(page.locator(".image-result .message-images img")).toHaveCount(1);

      await page.getByRole("button", { name: "重新生成" }).click();
      await expect(page.locator(".image-result .version-switch")).toContainText("2 / 2");
      await expect.poll(() => provider.requests.filter((entry: { kind?: string }) => entry.kind === "image").length).toBe(2);
      await page.getByRole("button", { name: "上一版本" }).click();
      await expect(page.locator(".image-result .version-switch")).toContainText("1 / 2");

      await page.getByRole("button", { name: "编辑参数" }).click();
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue("雨后的未来图书馆");
    } finally {
      if (sessionId) await api(request, APP_URL, "DELETE", `/api/image-sessions/${sessionId}`).catch(() => {});
      await provider.close();
    }
  });
});
