import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";
import { readFileSync } from "node:fs";

// Full Chromium's headless mode supports notifications; headless-shell always denies them.
test.use({ channel: "chromium" });
test.skip(({ browserName }) => browserName !== "chromium", "系统通知权限在 Chromium 中自动验证");
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const values: Array<{ generationId: string; status: string }> = [];
    (window as any).notificationEvents = values;
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("generation-state", (event) => values.push(JSON.parse((event as MessageEvent).data).generation));
      }
    };
  });
});

async function ready(page: Page) {
  await page.goto(`${APP_URL}/settings/general`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect(page.getByRole("switch", { name: "开启会话通知" })).toBeEnabled();
}
async function notifications(page: Page) {
  return page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())
    .filter((item) => item.tag.startsWith("llm-chat:")).map((item) => ({ title: item.title, tag: item.tag, data: item.data })));
}
async function flush(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await new Promise<void>((resolve) => {
      const ports = new MessageChannel();
      ports.port1.onmessage = () => { ports.port1.close(); ports.port2.close(); resolve(); };
      registration.active!.postMessage({ type: "CHAT_NOTIFICATIONS", command: { kind: "sync" } }, [ports.port2]);
    });
  });
}
async function observed(page: Page, generationId: string, status: string) {
  await expect.poll(() => page.evaluate(({ generationId, status }) =>
    (window as any).notificationEvents.some((item: any) => item.generationId === generationId && item.status === status), { generationId, status })).toBe(true);
  await flush(page);
}
async function fixture(request: APIRequestContext, tool = false) {
  const provider = await startMockProvider(tool ? { toolCall: { name: "get_time_info", arguments: "{}" } } : {});
  const connection = await api(request, APP_URL, "POST", "/api/connections", {
    name: `notifications-${Date.now()}`, protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {}
  });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const input = agentInput(`notifications-${Date.now()}`, model.id);
  if (tool) input.execution.tools.approvalOverrides = { get_time_info: "always" };
  const agent = await api(request, APP_URL, "POST", "/api/agents", input);
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "通知测试会话" });
  const send = () => api(request, APP_URL, "POST", `/api/conversations/${conversation.id}/messages`, { text: "测试通知" });
  return { provider, agent, conversation, send, cleanup: async () => {
    const messages = await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}/messages`);
    for (const message of messages) for (const generation of message.generations) {
      if (["running", "queued", "waiting-approval"].includes(generation.status)) {
        await api(request, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${generation.id}`)).status).toMatch(/^(stopped|failed|completed)$/);
      }
    }
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  } };
}

test("已授权时开启通知，其他页面收到一次提醒，目标会话前台静默，关闭后停止", async ({ page, context, request }) => {
  await context.grantPermissions(["notifications"]);
  const data = await fixture(request);
  try {
    await ready(page);
    const toggle = page.getByRole("switch", { name: "开启会话通知" });
    await expect(toggle).not.toBeChecked(); await toggle.click(); await expect(toggle).toBeChecked();
    const other = await context.newPage(); await ready(other);
    await expect(other.getByRole("switch", { name: "开启会话通知" })).toBeChecked();
    const worker = context.serviceWorkers()[0]!;
    await worker.evaluate(() => {
      const scope = self as unknown as ServiceWorkerGlobalScope;
      const original = scope.registration.showNotification.bind(scope.registration);
      (self as any).noticeCalls = 0;
      scope.registration.showNotification = async (title, options) => {
        (self as any).noticeCalls++;
        (self as any).lastNoticeClients = (await scope.clients.matchAll({ type: "window", includeUncontrolled: true }))
          .map((client) => ({ url: client.url, focused: client.focused, visible: client.visibilityState }));
        return original(title, options);
      };
    });
    const first = await data.send();
    await observed(page, first.generationId, "completed"); await flush(other);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect((await notifications(page))[0]).toMatchObject({ title: "回复已完成", data: { conversationId: data.conversation.id } });
    expect(await worker.evaluate(() => (self as any).noticeCalls)).toBe(1);

    // Exercise the worker-to-SPA click bridge without relying on an OS notification UI in headless CI.
    await worker.evaluate(async (path) => {
      const scope = self as unknown as ServiceWorkerGlobalScope;
      const clients = await scope.clients.matchAll({ type: "window" });
      clients[0]!.postMessage({ type: "CHAT_NOTIFICATION_OPEN", path });
    }, `/c/${data.conversation.id}`);
    await expect(other).toHaveURL(`${APP_URL}/c/${data.conversation.id}`);
    await other.bringToFront();
    await expect.poll(() => notifications(other)).toHaveLength(0);
    const second = await data.send();
    await observed(other, second.generationId, "completed"); await flush(page);
    expect(await notifications(other), JSON.stringify(await worker.evaluate(() => (self as any).lastNoticeClients))).toHaveLength(0);
    expect(await worker.evaluate(() => (self as any).noticeCalls)).toBe(1);

    await page.bringToFront(); await toggle.click(); await expect(toggle).not.toBeChecked();
    const third = await data.send(); await observed(page, third.generationId, "completed");
    expect(await notifications(page)).toHaveLength(0);
    await other.close();
  } finally { await page.goto("about:blank"); await data.cleanup(); }
});

test("工具待审批通知在批准后关闭，完成后提醒；首次打开不补发历史", async ({ page, context, request }) => {
  await context.grantPermissions(["notifications"]);
  const data = await fixture(request, true);
  try {
    await ready(page); await page.getByRole("switch", { name: "开启会话通知" }).click();
    await expect(page.getByRole("switch", { name: "开启会话通知" })).toBeChecked();
    const turn = await data.send(); await observed(page, turn.generationId, "waiting-approval");
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect((await notifications(page))[0]?.title).toBe("工具待审批");
    const generation = await api(request, APP_URL, "GET", `/api/generations/${turn.generationId}`);
    await api(request, APP_URL, "POST", `/api/tool-calls/${generation.toolCalls[0].id}/approval`, { approved: true });
    await observed(page, turn.generationId, "completed");
    await expect.poll(async () => (await notifications(page)).map((item) => item.title)).toEqual(["回复已完成"]);
    await page.evaluate(async () => { for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close(); });
    await page.reload(); await expect(page.getByRole("switch", { name: "开启会话通知" })).toBeChecked();
    await flush(page); expect(await notifications(page)).toHaveLength(0);
  } finally { await page.goto("about:blank"); await data.cleanup(); }
});

for (const permission of ["denied", "default"] as const) {
  test(`权限请求返回 ${permission} 时保持关闭并显示下一步`, async ({ page }) => {
    await page.addInitScript((result) => {
      let current: NotificationPermission = "default";
      (window as any).permissionRequests = [];
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => current });
      Notification.requestPermission = async () => {
        (window as any).permissionRequests.push(navigator.userActivation.isActive);
        current = result; return current;
      };
    }, permission);
    await ready(page);
    const card = page.getByLabel("会话通知", { exact: true });
    const toggle = card.getByRole("switch", { name: "开启会话通知" });
    await toggle.click(); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
    await expect(card.getByRole("status")).toContainText(permission === "denied" ? "站点设置" : "尚未允许");
    expect(await page.evaluate(() => (window as any).permissionRequests)).toEqual([true]);
    if (permission === "denied") { await toggle.click(); await expect(toggle).toBeEnabled(); expect(await page.evaluate(() => (window as any).permissionRequests)).toEqual([true]); }
  });
}

test("退出登录清除现存通知并停止接收新通知", async ({ page, context, request }) => {
  await context.grantPermissions(["notifications"]);
  // Use a separate login so logging out does not revoke the shared API fixture's session.
  const credentials = JSON.parse(readFileSync(process.env.E2E_STATE_FILE!, "utf8"));
  const login = await page.request.post(`${APP_URL}/api/auth/login`, {
    headers: { "x-llm-chat-request": "1" }, data: { password: credentials.appPassword }
  });
  expect(login.ok()).toBe(true);
  const data = await fixture(request);
  try {
    await ready(page);
    const toggle = page.getByRole("switch", { name: "开启会话通知" });
    await toggle.click(); await expect(toggle).toBeChecked();
    const first = await data.send(); await observed(page, first.generationId, "completed");
    await expect.poll(() => notifications(page)).toHaveLength(1);
    await page.goto(`${APP_URL}/settings/security`);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByLabel("访问密码")).toBeVisible();
    await expect.poll(() => notifications(page)).toHaveLength(0);
    const second = await data.send();
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${second.generationId}`)).status).toBe("completed");
    await flush(page); expect(await notifications(page)).toHaveLength(0);
  } finally { await page.goto("about:blank"); await data.cleanup(); }
});

test("不支持通知时禁用开关并说明原因", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "Notification", { configurable: true, value: undefined }); });
  await page.goto(`${APP_URL}/settings/general`);
  const card = page.getByLabel("会话通知", { exact: true });
  await expect(card.getByRole("switch", { name: "开启会话通知" })).toBeDisabled();
  await expect(card.getByRole("status")).toContainText("当前浏览器不支持会话通知");
});
