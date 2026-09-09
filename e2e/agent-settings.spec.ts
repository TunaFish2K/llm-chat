import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

test("通用设置链接到所选 Agent，生成配置只修改该 Agent", async ({ page, request }) => {
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const first = await api(request, APP_URL, "POST", "/api/agents", agentInput(`settings-first-${Date.now()}`));
  const second = await api(request, APP_URL, "POST", "/api/agents", agentInput(`settings-second-${Date.now()}`));
  try {
    await api(request, APP_URL, "PATCH", "/api/settings", { defaultAgentId: first.id });
    await page.goto(`${APP_URL}/settings/general`);
    for (const label of ["默认模型", "默认上下文策略", "默认推理档位", "默认系统提示"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("link", { name: "编辑此 Agent" })).toHaveAttribute("href", `/agents/${first.id}`);
    await page.getByLabel("默认 Agent", { exact: true }).selectOption(second.id);
    await expect.poll(async () => (await api(request, APP_URL, "GET", "/api/settings")).defaultAgentId).toBe(second.id);
    await page.getByRole("link", { name: "编辑此 Agent" }).click();
    await expect(page).toHaveURL(`${APP_URL}/agents/${second.id}`);
    await page.getByRole("button", { name: "展开编辑基础系统提示", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "基础系统提示", exact: true });
    await editor.getByRole("textbox").fill("Only this Agent's instructions");
    await editor.getByRole("button", { name: "应用", exact: true }).click();
    await page.getByRole("tab", { name: "执行配置" }).click();
    await page.getByLabel("上下文策略", { exact: true }).selectOption("full");
    await page.getByLabel("推理档位", { exact: true }).selectOption("high");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
    const saved = await api(request, APP_URL, "GET", `/api/agents/${second.id}`);
    expect(saved.execution).toMatchObject({ baseSystemPrompt: "Only this Agent's instructions", contextPolicy: "full", reasoningEffort: "high", modelId: null });
    expect((await api(request, APP_URL, "GET", `/api/agents/${first.id}`)).execution).toEqual(first.execution);
    await page.reload();
    await expect(page.getByRole("button", { name: "展开编辑基础系统提示", exact: true })).toContainText("Only this Agent's instructions");
  } finally {
    await api(request, APP_URL, "PATCH", "/api/settings", { defaultAgentId: original.defaultAgentId });
    await api(request, APP_URL, "DELETE", `/api/agents/${first.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${second.id}`);
  }
});
