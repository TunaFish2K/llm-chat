import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, AUTH_URL, initialPassword, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("离线冷启动可搜索未打开的会话、查看图片及版本，恢复联网后同步删除", async ({ page, context, request }) => {
  const image = await api(request, APP_URL, "POST", "/api/images", { fileName: "offline.png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=" });
  const provider = await startMockProvider({ responseText: `离线测试正文\n\n![离线图片](${image.url})` });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Offline", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("离线助手", model.id));
  const first = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "离线记录甲" });
  const wait = (id: string) => expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${id}`)).status).toBe("completed");
  await wait(first.generation.generationId);
  const retry = await api(request, APP_URL, "POST", `/api/messages/${first.generation.assistantMessageId}/generations`, {});
  await wait(retry.generationId);
  const second = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "未打开的离线记录乙" });
  await wait(second.generation.generationId);
  const fork = await api(request, APP_URL, "POST", `/api/conversations/${second.conversation.id}/forks`, { mode: "continue", throughMessageId: second.generation.assistantMessageId });
  try {
    await page.goto(`${APP_URL}/settings/general`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect(page.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith("llm-chat-history-images-")).length)).toBe(1);
    await context.setOffline(true);
    const cold = await context.newPage();
    const mutations: string[] = [];
    cold.on("request", (req) => { if (req.url().includes("/api/") && !["GET", "HEAD"].includes(req.method())) mutations.push(req.url()); });
    await cold.goto(`${APP_URL}/c/${first.conversation.id}`);
    await expect(cold.locator(".offline-banner")).toContainText("离线查阅");
    await expect(cold.locator('.msg[data-role="assistant"]').last()).toContainText("离线测试正文");
    await expect.poll(() => cold.getByAltText("离线图片").last().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await cold.getByRole("button", { name: "上一版本", exact: true }).click();
    await expect(cold.getByLabel("生成版本切换")).toContainText("1 / 2");
    await cold.getByLabel("输入消息", { exact: true }).fill("离线草稿");
    await expect(cold.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(cold.locator('.msg[data-role="assistant"]').last().getByRole("button", { name: "重试", exact: true })).toBeDisabled();
    await openDrawerIfNeeded(cold);
    await cold.getByRole("button", { name: "搜索会话", exact: true }).click();
    await cold.getByRole("searchbox").fill("未打开的离线记录乙");
    await cold.getByRole("dialog").getByRole("button").filter({ hasText: "未打开的离线记录乙" }).first().click();
    await expect(cold).toHaveURL(new RegExp(`${second.conversation.id}|${fork.conversation.id}`));
    await expect(cold.locator('.msg[data-role="user"]')).toContainText("未打开的离线记录乙");
    await cold.goto(`${APP_URL}/c/${fork.conversation.id}`);
    await expect(cold.locator('.msg[data-role="assistant"]').last()).toContainText("离线测试正文");
    await cold.reload();
    await expect(cold.locator('.msg[data-role="user"]')).toContainText("未打开的离线记录乙");
    expect(mutations).toEqual([]);
    await context.setOffline(false);
    await expect(cold.locator(".offline-banner")).toHaveCount(0);
    await api(request, APP_URL, "DELETE", `/api/conversations/${first.conversation.id}`);
    await page.getByRole("button", { name: "立即同步", exact: true }).click();
    await expect.poll(() => page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const req = indexedDB.open("llm-chat-history", 1); req.onsuccess = () => resolve(req.result); });
      return new Promise<boolean>((resolve) => { const req = db.transaction("conversations").objectStore("conversations").get(id); req.onsuccess = () => { resolve(!req.result); db.close(); }; });
    }, first.conversation.id)).toBe(true);
    // The deleted and surviving conversations share this image.
    await expect.poll(() => cold.evaluate(async (url) => {
      const key = (await caches.keys()).find((key) => key.startsWith("llm-chat-history-images-"));
      return Boolean(key && await (await caches.open(key)).match(url));
    }, image.url)).toBe(true);
    await page.getByRole("button", { name: "清除本机记录并关闭" }).click();
    await expect(page.getByLabel("离线记录", { exact: true })).toContainText("已保存 0 / 0");
    await expect.poll(() => cold.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith("llm-chat-history-images-")).length)).toBe(0);
    await cold.close();
  } finally {
    await context.setOffline(false);
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${second.conversation.id}`);
    await provider.close();
  }
});


test("退出登录清除离线记录并通知其他标签页", async ({ page, context }) => {
  await page.goto(`${AUTH_URL}/settings/general`);
  await page.getByLabel("访问密码").fill(initialPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
  const other = await context.newPage();
  await other.goto(`${AUTH_URL}/settings/general`);
  await expect(other.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
  await page.goto(`${AUTH_URL}/settings/security`);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByLabel("访问密码")).toBeVisible();
  await expect(other.getByLabel("访问密码")).toBeVisible();
  const stored = await other.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const req = indexedDB.open("llm-chat-history", 1); req.onsuccess = () => resolve(req.result); });
    return new Promise<{ authorized: boolean }>((resolve) => { const req = db.transaction("meta").objectStore("meta").get("control"); req.onsuccess = () => { resolve(req.result); db.close(); }; });
  });
  expect(stored.authorized).toBe(false);
  await context.setOffline(true);
  await other.reload();
  await expect(other.locator(".app-frame")).toHaveCount(0);
});

test.describe("离线同步失败与清除", () => {
  test.use({ serviceWorkers: "block" });
  test("下载失败保留旧记录，清除后不接受迟到的下载", async ({ page, request }) => {
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("同步失败测试"));
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    await page.goto(`${APP_URL}/settings/general`);
    const card = page.getByLabel("离线记录", { exact: true });
    await expect(card).toContainText("最后完整同步");
    const snapshot = () => page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const req = indexedDB.open("llm-chat-history", 1); req.onsuccess = () => resolve(req.result); });
      return new Promise<{ conversation: { title: string } } | undefined>((resolve) => { const req = db.transaction("conversations").objectStore("conversations").get(id); req.onsuccess = () => { resolve(req.result); db.close(); }; });
    }, conversation.id);
    const original = await snapshot();
    expect(original).toBeTruthy();
    await api(request, APP_URL, "PATCH", `/api/conversations/${conversation.id}`, { title: "同步更新后的标题" });
    const route = `**/api/offline/conversations/${conversation.id}`;
    await page.route(route, (intercept) => intercept.fulfill({ status: 503, body: "unavailable" }));
    await card.getByRole("button", { name: "立即同步" }).click();
    await expect(card.getByRole("alert")).toContainText("503");
    expect((await snapshot())?.conversation.title).toBe(original!.conversation.title);
    await page.unroute(route);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let downloading = false;
    await page.route(route, async (intercept) => {
      const response = await intercept.fetch();
      downloading = true;
      await pending;
      await intercept.fulfill({ response }).catch(() => {});
    });
    await card.getByRole("button", { name: "立即同步" }).click();
    await expect.poll(() => downloading).toBe(true);
    await card.getByRole("button", { name: "清除本机记录并关闭" }).click();
    release();
    await expect(card.getByRole("status")).toContainText("已保存 0 / 0");
    expect(await snapshot()).toBeUndefined();
    await expect(card.getByRole("checkbox")).not.toBeChecked();
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
  });
});
