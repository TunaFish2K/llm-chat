import { test, expect, type Page } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

async function settingsAndBack(page: Page, title?: string) {
  await openDrawerIfNeeded(page);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await openDrawerIfNeeded(page);
  await page.getByRole("link", { name: title ? new RegExp(title) : "聊天", exact: !title }).click();
  await expect(page.locator(".mobile-drawer")).toHaveCount(0);
}

test("新对话和已有会话的文字附件在切设置和刷新后恢复", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`draft-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: `draft-existing-${Date.now()}` });
  try {
    await page.goto(APP_URL!);
    await page.getByLabel("输入消息").fill("新对话草稿");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "draft-note.txt", mimeType: "text/plain", buffer: Buffer.from("draft attachment") });
    await expect(page.getByLabel("待发送附件")).toContainText("draft-note.txt");
    await settingsAndBack(page);
    await expect(page.getByLabel("输入消息")).toHaveValue("新对话草稿");
    await expect(page.getByLabel("待发送附件")).toContainText("draft-note.txt");
    await page.reload();
    await expect(page.getByLabel("输入消息")).toHaveValue("新对话草稿");
    await expect(page.getByLabel("待发送附件")).toContainText("draft-note.txt");
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await expect(page.getByLabel("输入消息")).toHaveValue("");
    await page.getByLabel("输入消息").fill("已有会话草稿");
    await settingsAndBack(page, conversation.title);
    await expect(page.getByLabel("输入消息")).toHaveValue("已有会话草稿");
    await page.reload();
    await expect(page.getByLabel("输入消息")).toHaveValue("已有会话草稿");
    await page.goto(APP_URL!);
    await expect(page.getByLabel("输入消息")).toHaveValue("新对话草稿");
  } finally {
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});

test("选模型后未发送也跨浏览器记忆，发送后草稿清除", async ({ page, request, browser }) => {
  const provider = await startMockProvider();
  const original = await api(request, APP_URL, "GET", "/api/settings");
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "model-memory", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { displayName: "Memory test model", contextWindow: 128000 });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`memory-${Date.now()}`));
  const secondContext = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    await api(request, APP_URL, "PATCH", "/api/settings", { lastAgentId: agent.id });
    await page.goto(APP_URL!);
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("button", { name: /Memory test model/ }).click();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/agents/${agent.id}`)).lastSelectedModelId).toBe(model.id);
    await secondContext.addInitScript(() => localStorage.setItem("llm-chat.quick-tour.v1", "seen"));
    const secondPage = await secondContext.newPage();
    await secondPage.goto(APP_URL!);
    await expect(secondPage.getByRole("button", { name: "选择模型", exact: true })).toHaveAttribute("title", "Memory test model");
    await page.getByLabel("输入消息").fill("发送并清除草稿");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page).toHaveURL(/\/c\//);
    await expect(page.getByLabel("输入消息")).toHaveValue("");
    await page.reload();
    await expect(page.getByLabel("输入消息")).toHaveValue("");
    await page.goto(APP_URL!);
    await expect(page.getByLabel("输入消息")).toHaveValue("");
    await expect(page.getByRole("button", { name: "选择模型", exact: true })).toHaveAttribute("title", "Memory test model");
  } finally {
    await secondContext.close();
    const conversations = await api(request, APP_URL, "GET", "/api/conversations");
    for (const conversation of conversations.filter((item: { agentId: string }) => item.agentId === agent.id)) {
      const messages = await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/messages`);
      for (const message of messages) for (const generation of message.generations) {
        if (["queued", "running", "waiting-approval"].includes(generation.status)) await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
      }
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    }
    await api(request, APP_URL, "PATCH", "/api/settings", { lastAgentId: original.lastAgentId });
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});

test("手机从左缘返回按层级处理，纵向滚动允许浏览器原生刷新", async ({ page, request }) => {
  test.skip(test.info().project.name !== "mobile-chromium", "仅手机触摸手势");
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`swipe-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  const touch = await page.context().newCDPSession(page);
  const swipe = async () => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 12, y: 300 }] });
    for (const x of [28, 48, 72, 108]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 300 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  try {
    // Direct links have no parent visit in browser history.
    await page.goto(`${APP_URL}/c/${conversation.id}/tasks`);
    await expect(page.getByRole("button", { name: "返回上一级" })).toBeVisible();
    await swipe();
    await expect(page).toHaveURL(`${APP_URL}/c/${conversation.id}`);
    await swipe();
    await expect(page.locator(".mobile-drawer")).toBeVisible();
    await page.locator(".drawer-panel").getByRole("button", { name: "关闭导航", exact: true }).tap();
    const scroll = await page.locator(".chat-scroll").evaluate((element) => ({
      chatY: getComputedStyle(element).overscrollBehaviorY,
      rootY: getComputedStyle(document.documentElement).overscrollBehaviorY,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(scroll).toMatchObject({ chatY: "auto", rootY: "auto", rootOverflow: "auto" });
    expect(scroll.width).toBeLessThanOrEqual(scroll.viewport);
    await page.goto(`${APP_URL}/agents/${agent.id}`);
    await expect(page.getByRole("button", { name: "返回列表", exact: true })).toBeVisible();
    await swipe();
    await expect(page).toHaveURL(`${APP_URL}/agents`);
    await swipe();
    await expect(page.locator(".mobile-drawer")).toBeVisible();
  } finally {
    await touch.detach().catch(() => undefined);
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});
