import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

for (const delay of [200, 800, 2000]) {
  test(`发送请求等待 ${delay}ms 时先反馈并保留下一条草稿`, async ({ page, request }) => {
    const provider = await startMockProvider();
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: `feedback-${Date.now()}`, protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const discovery = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
    const model = discovery.created[0];
    await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`feedback-${Date.now()}`, model.id));
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    let posts = 0;
    await page.route(`**/api/conversations/${conversation.id}/messages`, async (route) => {
      if (route.request().method() === "POST") { posts++; await new Promise((resolve) => setTimeout(resolve, delay)); }
      await route.continue();
    });
    try {
      await page.goto(`${APP_URL}/c/${conversation.id}`);
      await page.getByLabel("输入消息").fill("即时反馈测试");
      const feedback = await page.evaluate(async () => {
        const start = performance.now();
        const send = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!;
        send.click(); send.click();
        await new Promise(requestAnimationFrame);
        return { elapsed: performance.now() - start,
          input: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value,
          preview: document.querySelector(".submission-preview")?.textContent };
      });
      expect(feedback.elapsed).toBeLessThan(100);
      expect(feedback.input).toBe(""); expect(feedback.preview).toBe("即时反馈测试");
      await page.getByLabel("输入消息").fill("下一条草稿");
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/messages`)).filter((item: { role: string }) => item.role === "user").length).toBe(1);
      await expect(page.locator(".submission-preview")).toHaveCount(0);
      expect(posts).toBe(1);
      await expect(page.getByLabel("输入消息")).toHaveValue("下一条草稿");
      await page.reload();
      await expect(page.getByLabel("输入消息")).toHaveValue("下一条草稿");
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
      await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
      await provider.close();
    }
  });
}

test("慢保存立即显示处理中，保留保存期间的新编辑", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`save-${Date.now()}`));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    if (route.request().method() === "PATCH") await held;
    await route.continue();
  });
  try {
    await page.goto(`${APP_URL}/agents/${agent.id}`);
    const name = page.getByLabel("名称", { exact: true });
    await name.fill("已提交的名称");
    const save = page.getByRole("button", { name: "保存修改", exact: true });
    await save.click();
    await expect(page.locator('button[data-action-pending="true"]')).toBeDisabled();
    await expect(page.locator('button[data-action-pending="true"]')).toContainText("保存中");
    await name.fill("继续编辑的名称");
    release();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).name).toBe("已提交的名称");
    await expect(name).toHaveValue("继续编辑的名称");
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeEnabled();
  } finally {
    release(); await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});
