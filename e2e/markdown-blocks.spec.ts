import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

const response = "示例：\n\n```python\nfirst = 1\nsecond = 2\n```\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n结束。";

test("code blocks keep their lines and both blocks put quiet icon actions in a header", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: response, reasoningChunks: [] });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Markdown blocks", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000, protocol: "openai-chat" });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("代码块助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "展示代码和表格" });
  try {
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    await expect(page.locator('.msg[data-role="assistant"]').last()).toContainText("结束。");
    await expect(page.locator('.stream[data-busy="true"]')).toHaveCount(0);

    const code = page.locator('[data-streamdown="code-block"]').last();
    const layout = await code.evaluate((block) => {
      const header = block.querySelector('[data-streamdown="code-block-header"]')!.getBoundingClientRect();
      const lines = [...block.querySelectorAll('[data-streamdown="code-block-body"] code > span')].map((line) => line.getBoundingClientRect().top);
      const buttons = [...block.querySelectorAll('[data-streamdown="code-block-actions"] button')].map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return { top: rect.top, bottom: rect.bottom, border: style.borderTopWidth, background: style.backgroundColor };
      });
      return { header, lines, buttons };
    });
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[1]!).toBeGreaterThan(layout.lines[0]! + 4);
    expect(layout.buttons).toHaveLength(2);
    for (const button of layout.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(layout.header.top - 1);
      expect(button.bottom).toBeLessThanOrEqual(layout.header.bottom + 1);
      expect(button.border).toBe("0px");
      expect(button.background).toBe("rgba(0, 0, 0, 0)");
    }

    const actions = page.getByRole("group", { name: "表格操作" });
    const table = await actions.evaluate((group) => {
      const header = group.closest(".markdown-table-header")!.getBoundingClientRect();
      const body = group.closest(".markdown-table")!.querySelector("table")!.getBoundingClientRect();
      const buttons = [...group.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      return { header, body, buttons };
    });
    expect(table.buttons).toHaveLength(3);
    for (const button of table.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(table.header.top - 1);
      expect(button.bottom).toBeLessThanOrEqual(table.body.top + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`).catch(() => {});
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`).catch(() => {});
    await provider.close();
  }
});
