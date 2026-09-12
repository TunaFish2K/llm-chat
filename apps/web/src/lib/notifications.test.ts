import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationControl } from "./notification-db";
import type { AppEvent } from "@llm-chat/contracts";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), navigate: vi.fn(), get: vi.fn(), deleted: vi.fn() }));
vi.mock("./notification-db", () => ({ readNotificationControl: mocks.read, writeNotificationControl: mocks.write }));
vi.mock("./api", () => ({ api: { get: mocks.get } }));
vi.mock("./router", () => ({ navigate: mocks.navigate }));
vi.mock("./conversation-lifecycle", () => ({ conversationDeleted: mocks.deleted }));

let saved: NotificationControl;
let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn>;
let postMessage: ReturnType<typeof vi.fn>;
let events: Map<string, (event: any) => void>;
let broadcast: { onmessage: (() => void) | null; postMessage: ReturnType<typeof vi.fn> };
let serviceWorker: { ready: Promise<{ active: { postMessage: typeof postMessage } | null }>; addEventListener: ReturnType<typeof vi.fn> };
let permissionChanged: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  saved = { enabled: false, authorized: true, revision: "initial" }; permission = "default"; events = new Map();
  mocks.read.mockImplementation(async () => ({ ...saved }));
  mocks.write.mockImplementation(async (patch, revision) => {
    if (revision !== undefined && revision !== saved.revision) throw new Error("通知设置已变化，请重试");
    saved = { ...saved, ...patch, revision: crypto.randomUUID() }; return saved;
  });
  mocks.deleted.mockReturnValue(false);
  requestPermission = vi.fn(async () => { permission = "granted"; return permission; });
  postMessage = vi.fn((_message, ports) => {
    queueMicrotask(() => ports[0].peer.onmessage?.({ data: { ok: true } }));
  });
  serviceWorker = { ready: Promise.resolve({ active: { postMessage } }),
    addEventListener: vi.fn((type, listener) => events.set(`sw:${type}`, listener)) };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("Notification", { get permission() { return permission; }, requestPermission });
  vi.stubGlobal("navigator", { serviceWorker, permissions: { query: vi.fn(async () => ({
    addEventListener: (_type: string, callback: () => void) => { permissionChanged = callback; }
  })) } });
  vi.stubGlobal("MessageChannel", class {
    port1 = { onmessage: null, close: vi.fn() }; port2 = { peer: this.port1, close: vi.fn() };
  });
  vi.stubGlobal("BroadcastChannel", class {
    onmessage = null; postMessage = vi.fn(); constructor() { broadcast = this; }
  });
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => { events.set(type, listener as (event: Event) => void); });
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => { events.set(type, listener as (event: Event) => void); });
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const module = await import("./notifications"); await module.initializeNotifications(); return module;
}

describe("notification preferences and permission", () => {
  it("initializes once without requesting permission and requests synchronously on click", async () => {
    const module = await setup(); await module.initializeNotifications();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(module.notificationStore.get()).toMatchObject({ supported: true, initialized: true, enabled: false });
    const enabling = module.setNotificationsEnabled(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(module.notificationStore.get().busy).toBe(true);
    await enabling;
    expect(module.notificationStore.get()).toMatchObject({ enabled: true, permission: "granted", busy: false });
    expect(saved.enabled).toBe(true); expect(broadcast.postMessage).toHaveBeenCalled();
    await module.setNotificationsEnabled(false);
    expect(saved.enabled).toBe(false); expect(permission).toBe("granted");
    await module.setNotificationsEnabled(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it.each(["denied", "default"] as const)("keeps the switch off after %s", async (result) => {
    requestPermission.mockImplementation(async () => { permission = result; return result; });
    const module = await setup(); await module.setNotificationsEnabled(true);
    expect(saved.enabled).toBe(false);
    expect(module.notificationStore.get()).toMatchObject({ enabled: false, permission: result, busy: false });
    expect(module.notificationStore.get().hint).toContain(result === "denied" ? "站点设置" : "尚未允许");
    if (result === "denied") { await module.setNotificationsEnabled(true); expect(requestPermission).toHaveBeenCalledOnce(); }
  });

  it("does not request permissions or enable in unsupported/insecure environments", async () => {
    vi.stubGlobal("isSecureContext", false);
    const module = await setup();
    expect(module.notificationStore.get().supported).toBe(false);
    await module.setNotificationsEnabled(true);
    expect(module.notificationStore.get().error).toContain("HTTPS");
    vi.stubGlobal("isSecureContext", true); vi.stubGlobal("Notification", undefined);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("recovers after permission request errors and storage initialization failures", async () => {
    mocks.read.mockRejectedValueOnce(new Error("本地存储不可用"));
    const module = await setup(); expect(module.notificationStore.get().error).toBe("本地存储不可用");
    requestPermission.mockRejectedValueOnce(new Error("权限申请失败"));
    await module.setNotificationsEnabled(true);
    expect(module.notificationStore.get().error).toBe("权限申请失败");
    await module.setNotificationsEnabled(true);
    expect(module.notificationStore.get().enabled).toBe(true);
    expect(serviceWorker.addEventListener).toHaveBeenCalledOnce();
  });

  it("keeps disabled if saving the preference fails", async () => {
    permission = "granted";
    const module = await setup(); mocks.write.mockRejectedValueOnce(new Error("磁盘已满"));
    await module.setNotificationsEnabled(true);
    expect(module.notificationStore.get()).toMatchObject({ enabled: false, error: "磁盘已满", busy: false });
  });

  it("discards a late permission grant after switch-off, logout, or another tab's change", async () => {
    let grant!: (value: NotificationPermission) => void;
    requestPermission.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const module = await setup();
    const first = module.setNotificationsEnabled(true);
    await module.setNotificationsEnabled(false); permission = "granted"; grant(permission); await first;
    expect(saved.enabled).toBe(false);
    permission = "default";
    const second = module.setNotificationsEnabled(true); module.stopNotificationSession();
    permission = "granted"; grant(permission); await second;
    await vi.waitFor(() => expect(saved.authorized).toBe(false));
    expect(saved.enabled).toBe(false);
    permission = "default";
    const third = module.setNotificationsEnabled(true); saved = { ...saved, revision: "other-tab" };
    permission = "granted"; grant(permission); await third;
    expect(saved.enabled).toBe(false);
  });

  it("updates after permission revocation and cross-tab preference changes", async () => {
    saved.enabled = true; permission = "granted";
    const module = await setup();
    permission = "denied"; permissionChanged?.();
    await vi.waitFor(() => expect(saved.enabled).toBe(false));
    expect(module.notificationStore.get().enabled).toBe(false);
    permission = "granted"; saved = { ...saved, enabled: true, revision: "remote" }; broadcast.onmessage?.();
    await vi.waitFor(() => expect(module.notificationStore.get().enabled).toBe(true));
    events.get("sw:message")?.({ data: { type: "CHAT_NOTIFICATION_OPEN", path: "/c/target" } });
    expect(mocks.navigate).toHaveBeenCalledWith("/c/target");
    events.get("sw:message")?.({ data: { type: "CHAT_NOTIFICATION_OPEN", path: "https://foreign.test/" } });
    expect(mocks.navigate).toHaveBeenCalledOnce();
    const reply = vi.fn();
    events.get("sw:message")?.({ data: { type: "CHAT_NOTIFICATION_CONTEXT" }, ports: [{ postMessage: reply }] });
    expect(reply).toHaveBeenCalledWith({ path: location.pathname });
    events.get("llm-chat:conversations-deleted")?.({ detail: { ids: ["target"] } });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: "clear-conversations", ids: ["target"], locale: "zh-CN" } }), expect.anything()));
  });

  it("handles missing workers, worker errors and an old worker that never acknowledges", async () => {
    permission = "granted"; const module = await setup();
    serviceWorker.ready = Promise.resolve({ active: null });
    await module.setNotificationsEnabled(true);
    expect(module.notificationStore.get().error).toContain("尚未就绪");
    serviceWorker.ready = Promise.resolve({ active: { postMessage } });
    postMessage.mockImplementationOnce((_message, ports) => queueMicrotask(() => ports[0].peer.onmessage({ data: { ok: false, error: "worker failed" } })));
    await module.setNotificationsEnabled(true); expect(module.notificationStore.get().error).toBe("worker failed");
    vi.useFakeTimers(); postMessage.mockImplementation(() => {});
    const attempt = module.setNotificationsEnabled(true);
    await vi.advanceTimersByTimeAsync(5001); await attempt;
    expect(module.notificationStore.get()).toMatchObject({ enabled: false, busy: false });
    expect(module.notificationStore.get().error).toContain("更新应用");
  });
});

it("feeds only authenticated, permitted, non-deleted generations to the worker and fences logout races", async () => {
  permission = "granted"; saved.enabled = true; saved.authorized = false;
  const module = await setup(); module.startNotificationSession(); module.startNotificationSession();
  await vi.waitFor(() => expect(saved.authorized).toBe(true));
  const event: AppEvent = { type: "generation-state", id: 1, generation: {
    generationId: "g", conversationId: "c", conversationTitle: "会话", messageId: "m", status: "completed", stopReason: null, pendingTools: []
  } };
  module.observeNotificationEvent({ type: "generation-snapshot", id: 0, sourceId: "server", active: [] });
  module.observeNotificationEvent(event);
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "generation", notify: true }) }), expect.anything()));
  postMessage.mockClear(); mocks.deleted.mockReturnValue(true);
  module.observeNotificationEvent({ ...event, id: 2 }); await Promise.resolve(); await Promise.resolve();
  expect(postMessage).not.toHaveBeenCalled();
  module.observeNotificationEvent({ ...event, id: 3 }); module.stopNotificationSession();
  await vi.waitFor(() => expect(saved.authorized).toBe(false));
  expect(postMessage.mock.calls.every(([message]) => message.command.kind === "sync")).toBe(true);
  module.startNotificationSession(); await vi.waitFor(() => expect(saved.authorized).toBe(true));
});
