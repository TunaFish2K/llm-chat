import type { AppEvent, GenerationDto } from "@llm-chat/contracts";
import { api } from "./api";
import { conversationDeleted } from "./conversation-lifecycle";
import { readNotificationControl, writeNotificationControl, type NotificationControl } from "./notification-db";
import type { NotificationCommand } from "./notification-protocol";
import { NotificationTracker } from "./notification-tracker";
import { navigate } from "./router";
import { createStore } from "./store";

interface NotificationSettings {
  initialized: boolean;
  supported: boolean;
  permission: NotificationPermission;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  hint: string | null;
}

export const notificationStore = createStore<NotificationSettings>({
  initialized: false, supported: false, permission: "default", enabled: false, busy: false, error: null, hint: null
});
let control: NotificationControl = { enabled: false, authorized: false, revision: "initial" };
let initialization: Promise<void> | undefined;
let channel: BroadcastChannel | undefined;
let listening = false;
let operation = 0;
let session = 0;
let authenticated = false;
let sessionReady: Promise<void> = Promise.resolve();
const changesKey = "llm-chat.notifications.changed";

function announce(): void {
  channel?.postMessage("changed");
  // Older browsers without BroadcastChannel still synchronize their switches.
  try { localStorage.setItem(changesKey, crypto.randomUUID()); } catch { /* IndexedDB remains authoritative. */ }
}

function supported(): boolean {
  return window.isSecureContext && typeof Notification !== "undefined" && typeof Notification.requestPermission === "function"
    && "serviceWorker" in navigator && "indexedDB" in window && "MessageChannel" in window;
}
function permission(): NotificationPermission { return typeof Notification !== "undefined" ? Notification.permission : "default"; }
function failure(error: unknown): void {
  notificationStore.set({ error: error instanceof Error ? error.message : "通知服务不可用，请重试" });
}
function accept(value: NotificationControl): void {
  control = value;
  notificationStore.set({ enabled: value.enabled && permission() === "granted", permission: permission() });
}

function timeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("通知服务尚未就绪，请更新应用后重试")), 5000);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

export async function notificationCommand(command: NotificationCommand): Promise<void> {
  const registration = await timeout(navigator.serviceWorker.ready);
  if (command.kind === "generation" && (!authenticated || conversationDeleted(command.state.conversationId)
    || !control.enabled || permission() !== "granted" || command.revision !== control.revision)) return;
  if (!registration.active) throw new Error("通知服务尚未就绪，请刷新页面后重试");
  const ports = new MessageChannel();
  try {
    await timeout(new Promise<void>((resolve, reject) => {
      ports.port1.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
        if (event.data.ok) resolve(); else reject(new Error(event.data.error ?? "通知服务不可用"));
      };
      registration.active!.postMessage({ type: "CHAT_NOTIFICATIONS", command }, [ports.port2]);
    }));
  } finally { ports.port1.close(); ports.port2.close(); }
}

const tracker = new NotificationTracker((sourceId, state, notify) => {
  if (!authenticated || conversationDeleted(state.conversationId) || !control.enabled || permission() !== "granted") return;
  void notificationCommand({ kind: "generation", sourceId, state, notify, revision: control.revision }).catch(failure);
}, (id) => api.get<GenerationDto>(`/api/generations/${encodeURIComponent(id)}`));

async function synchronize(): Promise<void> {
  if (!supported()) return;
  accept(await readNotificationControl());
  if (control.enabled && permission() !== "granted") {
    try { accept(await writeNotificationControl({ enabled: false }, control.revision)); }
    catch (error) {
      const latest = await readNotificationControl();
      if (latest.enabled) throw error;
      accept(latest);
    }
    announce();
  }
}

export function initializeNotifications(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const available = supported();
    notificationStore.set({ supported: available, permission: permission() });
    if (!available) { notificationStore.set({ initialized: true }); return; }
    if (!listening) listen();
    await synchronize();
    notificationStore.set({ initialized: true });
  })().catch((error) => { initialization = undefined; notificationStore.set({ initialized: true }); failure(error); });
  return initialization;
}

function listen(): void {
  listening = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("llm-chat-notifications");
    channel.onmessage = () => { void synchronize().catch(failure); };
  }
  window.addEventListener("storage", (event) => { if (event.key === changesKey) void synchronize().catch(failure); });
  const foreground = () => {
    void synchronize().then(() => notificationCommand({ kind: "foreground" })).catch(failure);
  };
  window.addEventListener("focus", foreground);
  window.addEventListener("pageshow", foreground);
  window.addEventListener("popstate", foreground);
  document.addEventListener("visibilitychange", foreground);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "CHAT_NOTIFICATION_CONTEXT") {
      event.ports[0]?.postMessage({ path: location.pathname });
    }
    if (event.data?.type === "CHAT_NOTIFICATION_OPEN" && typeof event.data.path === "string"
      && /^\/c\/[^/?#]+$/.test(event.data.path)) navigate(event.data.path);
  });
  window.addEventListener("llm-chat:conversations-deleted", (event) => {
    const ids = (event as CustomEvent<{ ids: string[] }>).detail.ids;
    tracker.forget(ids);
    void notificationCommand({ kind: "clear-conversations", ids }).catch(failure);
  });
  if (navigator.permissions?.query) {
    void navigator.permissions.query({ name: "notifications" }).then((status) => {
      status.addEventListener("change", foreground);
    }).catch(() => {});
  }
}

/** requestPermission is called before any await, preserving the click's user activation. */
export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  const currentOperation = ++operation;
  const revision = control.revision;
  notificationStore.set({ busy: true, error: null, hint: null });
  try {
    if (!supported()) throw new Error(window.isSecureContext ? "当前浏览器不支持会话通知" : "会话通知需要 HTTPS 或本机地址");
    const result = enabled && permission() === "default" ? await Notification.requestPermission() : permission();
    if (currentOperation !== operation) return;
    if (!initialization) await initializeNotifications();
    notificationStore.set({ permission: result });
    if (enabled && result !== "granted") {
      accept(await writeNotificationControl({ enabled: false }, revision));
      notificationStore.set({ hint: result === "denied" ? "通知已被拒绝，请在浏览器的站点设置中允许通知后重新开启。" : "尚未允许通知，可再次点击开启。" });
    } else {
      if (enabled) await notificationCommand({ kind: "sync" });
      if (currentOperation !== operation) return;
      accept(await writeNotificationControl({ enabled }, revision));
    }
    announce();
    if (!control.enabled) await notificationCommand({ kind: "sync" });
  } catch (error) {
    if (currentOperation === operation) { failure(error); await synchronize().catch(failure); }
  } finally {
    if (currentOperation === operation) notificationStore.set({ busy: false });
  }
}

export function startNotificationSession(): void {
  if (authenticated) return;
  authenticated = true;
  const current = ++session;
  sessionReady = sessionReady.then(() => initializeNotifications()).then(async () => {
    if (!supported() || current !== session) return;
    const saved = await readNotificationControl();
    if (current !== session) return;
    accept(saved.authorized ? saved : await writeNotificationControl({ authorized: true }, saved.revision));
    announce();
  }).catch(failure);
}

export function stopNotificationSession(): Promise<void> {
  authenticated = false; session++; operation++;
  tracker.reset(); notificationStore.set({ busy: false });
  if (!supported()) return Promise.resolve();
  sessionReady = sessionReady.then(async () => {
    accept(await writeNotificationControl({ authorized: false }));
    announce();
    await notificationCommand({ kind: "sync" });
  }).catch(failure);
  return sessionReady;
}

export function observeNotificationEvent(event: AppEvent): void {
  const current = session;
  void sessionReady.then(() => {
    if (authenticated && current === session) tracker.handle(event);
  });
}
