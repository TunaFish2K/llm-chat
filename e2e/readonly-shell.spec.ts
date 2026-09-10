import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

test("只读命令策略可保存并恢复", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`readonly-${Date.now()}`));
  try {
    await page.goto(`${APP_URL}/agents/${agent.id}`);
    await page.getByRole("tab", { name: "工具", exact: true }).click();
    await expect(page.getByText("只读、不联网；默认免审批。", { exact: true })).toBeVisible();
    for (const [label, choice] of [["启用策略", "停用"], ["直接性", "惰性"], ["审批策略", "每次"]]) {
      await page.getByRole("group", { name: `只读命令 ${label}`, exact: true }).getByRole("button", { name: choice, exact: true }).click();
    }
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
    const saved = await api(request, APP_URL, "GET", `/api/agents/${agent.id}`);
    expect(saved.execution.tools).toMatchObject({ overrides: { workspace_shell_readonly: false },
      directOverrides: { workspace_shell_readonly: false }, approvalOverrides: { workspace_shell_readonly: "always" } });
    await page.reload();
    await page.getByRole("tab", { name: "工具", exact: true }).click();
    await expect(page.getByRole("group", { name: "只读命令 审批策略", exact: true }).getByRole("button", { name: "每次", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally { await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`); }
});

test("只读沙箱不可用时显示具体原因", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`readonly-unavailable-${Date.now()}`));
  try {
    await page.route("**/api/tools/catalog*", async (route) => {
      const response = await route.fetch();
      const entries = await response.json();
      await route.fulfill({ response, json: entries.map((entry) => entry.name === "workspace_shell_readonly"
        ? { ...entry, available: false, error: "需要 Bubblewrap 0.12.0 或更高版本，请升级后重启服务" } : entry) });
    });
    await page.goto(`${APP_URL}/agents/${agent.id}`);
    await page.getByRole("tab", { name: "工具", exact: true }).click();
    await expect(page.getByText(/只读、不联网；默认免审批。需要 Bubblewrap 0.12.0/)).toBeVisible();
  } finally { await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`); }
});
