import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  const cn = locale === "zh-CN";
  test("saves Agent container settings without starting an environment", async ({ page, request }) => {
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Container settings"));
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    try {
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      const mode = page.getByLabel(cn ? "执行环境" : "Execution environment", { exact: true });
      await expect(mode).toHaveValue("host");
      await mode.selectOption("container");
      await page.getByLabel(cn ? "容器引擎" : "Container engine", { exact: true }).selectOption("podman");
      await page.getByLabel(cn ? "镜像" : "Image", { exact: true }).fill("my-runtime:local");
      await page.getByLabel(cn ? "空闲停止（分钟）" : "Stop when idle (minutes)", { exact: true }).fill("30");
      await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
      await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
      const saved = await api(request, APP_URL, "GET", `/api/agents/${agent.id}`);
      expect(saved.execution.environment).toEqual({ type: "container", engine: "podman", image: "my-runtime:local", idleTimeoutMinutes: 30 });
      await page.reload();
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      await expect(mode).toHaveValue("container");
      expect(await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/environments`)).toEqual([]);
      await page.goto(`/c/${conversation.id}`);
      await page.locator(".composer-settings-trigger").click();
      await page.locator("[data-execution-settings]").click();
      await expect(page.getByRole("dialog").getByText(cn ? "尚未启动容器环境。" : "No container environment has started yet.", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    }
  });

  test("runs a real container tool without approval and stops or resets from advanced settings", async ({ page, request }) => {
    test.skip(!(process.env.LLM_CHAT_TEST_CONTAINER_ENGINES ?? "").split(",").includes("docker"), "Requires the local Docker runtime image");
    const provider = await startMockProvider({ toolCall: { name: "workspace_shell", arguments: JSON.stringify({ command: "pwd; printf e2e-container > proof.txt" }) } });
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Container E2E", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = await api(request, APP_URL, "POST", "/api/models", { connectionId: connection.id, modelKey: "container-e2e", displayName: "Container E2E", contextWindow: 128000, maxOutputTokens: 4096,
      capabilities: { tools: true }, defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true });
    const input = agentInput("Container E2E", model.id);
    const agent = await api(request, APP_URL, "POST", "/api/agents", { ...input, execution: { ...input.execution,
      environment: { type: "container", engine: "docker", image: process.env.LLM_CHAT_TEST_CONTAINER_IMAGE ?? "llm-chat-runtime:local", idleTimeoutMinutes: 15 },
      tools: { ...input.execution.tools, directOverrides: { workspace_shell: true }, approvalOverrides: { workspace_shell: "always" } }
    } });
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    try {
      await page.goto(`/c/${conversation.id}`);
      expect(await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/environments`)).toEqual([]);
      await page.locator(".composer textarea").first().fill("Run the container command");
      await page.getByRole("button", { name: cn ? "发送" : "Send", exact: true }).click();
      await expect.poll(() => provider.requests.length, { timeout: 30000 }).toBe(2);
      await expect(page.locator(".composer-stop-button")).toHaveCount(0);
      const result = provider.requests[1].messages.find((message: { role: string }) => message.role === "tool");
      expect(result.content).toContain("/workdir");
      const [environment] = await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/environments`);
      expect(environment.status).toBe("running");
      expect(await readFile(`${environment.workspacePath}/proof.txt`, "utf8")).toBe("e2e-container");
      await page.locator(".composer-settings-trigger").click();
      await page.locator("[data-execution-settings]").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: cn ? "停止环境" : "Stop environment", exact: true }).click();
      await expect(dialog.getByText(cn ? "已停止" : "Stopped", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: cn ? "重置环境" : "Reset environment", exact: true }).click();
      await expect(dialog.getByText(cn ? "尚未启动容器环境。" : "No container environment has started yet.", { exact: true })).toBeVisible();
      expect(await readFile(`${environment.workspacePath}/proof.txt`, "utf8")).toBe("e2e-container");
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
