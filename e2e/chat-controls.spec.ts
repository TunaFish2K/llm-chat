import { expect, test, type APIRequestContext } from "@playwright/test";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

async function setup(request: APIRequestContext, baseUrl: string) {
  const connection = await api(request, APP_URL, "POST", "/api/connections", {
    name: `controls-${Date.now()}`, protocol: "openai-chat", baseUrl, secretHeaders: {}
  });
  const discovery = await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`);
  const model = discovery.created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`controls-${Date.now()}`, model.id));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  return { conversation, cleanup: async () => {
    const conversations = await api(request, APP_URL, "GET", "/api/conversations");
    for (const item of conversations.filter((item: { agentId: string }) => item.agentId === agent.id)) {
      await api(request, APP_URL, "DELETE", `/api/conversations/${item.id}/queued-messages`);
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${item.id}/messages`);
      for (const message of messages) for (const generation of message.generations) {
        if (["queued", "running", "waiting-approval"].includes(generation.status)) {
          await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
          await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${generation.id}`)).status).toBe("stopped");
        }
      }
      await api(request, APP_URL, "DELETE", `/api/conversations/${item.id}`);
    }
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
  } };
}

test("生成中排队、跨设备同步、删除与取消后继续", async ({ page, browser, request }) => {
  const provider = await startMockProvider({ firstResponseDelayMs: 5000 });
  const fixture = await setup(request, provider.baseUrl);
  const other = await browser.newContext();
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await page.getByLabel("输入消息").fill("first");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".composer").getByRole("button", { name: "停止生成" })).toBeVisible();
    if (test.info().project.name === "mobile-chromium") await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.locator(".composer-tools").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const text of ["keep-a", "remove-b", "keep-c"]) {
      await page.getByLabel("输入消息").fill(text);
      await page.getByRole("button", { name: "加入队列", exact: true }).click();
      await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toContainText(text);
    }
    const second = await other.newPage();
    await second.goto(page.url());
    await expect(second.getByLabel("输入消息")).toHaveValue("");
    await expect(second.getByRole("region", { name: "待发送消息", exact: true })).toContainText("remove-b");
    await page.getByRole("button", { name: "删除待发送消息 remove-b" }).click();
    await expect(second.getByRole("region", { name: "待发送消息", exact: true })).not.toContainText("remove-b");
    await page.reload();
    await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toContainText("keep-c");
    await page.locator(".composer").getByRole("button", { name: "停止生成" }).click();
    await expect(page.getByRole("region", { name: "待发送消息", exact: true })).toHaveCount(0);
    await expect(second.getByLabel("消息列表", { exact: true }).getByText("keep-c", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
      return messages.at(-1)?.generations[0]?.status;
    }).toBe("completed");
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
    expect(messages.filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text)).toEqual(["first", "keep-a", "keep-c"]);
    expect(messages[1].generations[0].status).toBe("stopped");
  } finally { await other.close(); await fixture.cleanup(); await provider.close(); }
});

test("附件菜单、灯泡滑条与历史附件编辑分叉", async ({ page, request }) => {
  const provider = await startMockProvider();
  const fixture = await setup(request, provider.baseUrl);
  try {
    await page.goto(`${APP_URL}/c/${fixture.conversation.id}`);
    await expect(page.getByRole("button", { name: "选择模型" }).locator(".model-brand-icon")).toBeVisible();
    await expect(page.locator(".composer .lucide-image-plus")).toHaveCount(0);
    if (test.info().project.name === "mobile-chromium") await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("button", { name: "选择 Agent", exact: true }).click();
    const agentMenu = page.getByRole("dialog", { name: "Agent 选择", exact: true });
    await expect(agentMenu).toHaveAttribute("data-side", "top");
    const agentBox = await agentMenu.boundingBox();
    expect(agentBox!.x).toBeGreaterThanOrEqual(0);
    expect(agentBox!.x + agentBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (test.info().project.name === "mobile-chromium") await expect(page.getByRole("searchbox", { name: "搜索 Agent" })).not.toBeFocused();
    await agentMenu.locator(".agent-option[aria-pressed=true]").click();
    await expect(agentMenu).toHaveCount(0);
    await page.getByRole("button", { name: /^推理档位：/ }).click();
    const slider = page.getByRole("slider", { name: "推理档位" });
    await expect(slider).toHaveAttribute("aria-orientation", "vertical");
    const box = await page.locator(".reasoning-popover").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "添加附件" }).click();
    await expect(page.getByRole("button", { name: "上传图片", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上传文件", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("original") });
    await expect(page.getByLabel("待发送附件")).toContainText("original.txt");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
    await page.getByRole("button", { name: "编辑并分叉", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑并分叉" });
    await dialog.getByRole("button", { name: "移除 original.txt" }).click();
    await expect(dialog.getByRole("button", { name: "创建分支并生成" })).toBeDisabled();
    await dialog.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
    await expect(dialog.getByLabel("待发送附件")).toContainText("replacement.txt");
    await dialog.getByRole("button", { name: "创建分支并生成" }).click();
    await expect(page).not.toHaveURL(new RegExp(fixture.conversation.id));
    await expect(page.getByText("你好，这是 E2E 流式回复。")).toBeVisible();
    const forkId = page.url().split("/").at(-1);
    const original = await api(request, APP_URL, "GET", `/api/conversations/${fixture.conversation.id}/messages`);
    const fork = await api(request, APP_URL, "GET", `/api/conversations/${forkId}/messages`);
    expect(original[0].attachments.map((asset: { fileName: string }) => asset.fileName)).toEqual(["original.txt"]);
    expect(fork[0].attachments.map((asset: { fileName: string }) => asset.fileName)).toEqual(["replacement.txt"]);
  } finally { await fixture.cleanup(); await provider.close(); }
});
