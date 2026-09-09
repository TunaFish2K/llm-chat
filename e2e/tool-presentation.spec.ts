import { resolve } from "node:path";
import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const plugin of [false, true]) {
test(`${plugin ? "插件" : "内置工具"}展示缩略、详细 Markdown 和原始数据，刷新后保持一致`, async ({ page, request }, testInfo) => {
  if (plugin) await api(request, APP_URL, "POST", "/api/plugins/install", { sourcePath: resolve("examples/tool-markdown-plugin") });
  const provider = await startMockProvider({ toolCall: { name: plugin ? "plugin__markdown-example__echo" : "get_time_info", arguments: plugin ? JSON.stringify({ text: "echo input" }) : "{}" }, responseText: "工具已完成" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Presentation", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("工具展示", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "现在几点" });
  try {
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    await page.locator(".process-disclosure > summary").click();
    const call = page.locator(".tool-call");
    await expect(call.locator(".tool-markdown-summary")).toContainText(plugin ? "输入 10 个字符" : "无参数");
    for (const width of testInfo.project.name === "mobile-chromium" ? [360, 390] : [768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`tool-summary-${width}.png`) });
    }
    await call.locator("summary").click();
    await expect(call.locator(".tool-presentation .markdown")).toHaveCount(2);
    await expect(call.getByRole("button", { name: "查看原始数据" })).toBeVisible();
    await call.getByRole("button", { name: "查看原始数据" }).click();
    await expect(call.getByRole("button", { name: "复制原始输出" })).toBeVisible();
    await expect(call.locator(".tool-code-field").first()).toContainText(plugin ? "echo input" : "{}");
    await call.getByRole("button", { name: "查看格式化内容" }).click();
    await page.screenshot({ path: testInfo.outputPath("tool-expanded.png") });
    await call.getByRole("button", { name: "检查工具调用" }).click();
    await expect(page.getByRole("complementary", { name: "检查器" }).getByRole("button", { name: "查看原始数据" })).toBeVisible();
    if (plugin) await api(request, APP_URL, "POST", "/api/plugins/markdown-example/unload", {});
    await page.reload();
    await page.locator(".process-disclosure > summary").click();
    await expect(call.locator(".tool-markdown-summary")).toContainText(plugin ? "输入 10 个字符" : "无参数");
    expect(JSON.stringify(provider.requests)).not.toContain('"presentation":');
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${started.conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
    if (plugin) await api(request, APP_URL, "DELETE", "/api/plugins/markdown-example");
  }
});

}
