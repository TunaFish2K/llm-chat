/// <reference lib="webworker" />
import { claimNotification, readNotificationControl } from "./notification-db";
import { conversationPath, generationNotices, type ConversationNotification, type NotificationCommand } from "./notification-protocol";

interface NotificationEnvironment {
  origin: string;
  clients: Pick<Clients, "matchAll" | "get" | "openWindow">;
  registration: Pick<ServiceWorkerRegistration, "getNotifications" | "showNotification">;
  currentPath?: (client: WindowClient) => Promise<string | null>;
}

const prefix = "llm-chat:";
/** WindowClient.url can retain the document's original URL after SPA navigation. */
export function requestNotificationPath(client: WindowClient): Promise<string | null> {
  return new Promise((resolve) => {
    const ports = new MessageChannel();
    const finish = (path: string | null) => {
      clearTimeout(timer); ports.port1.close(); ports.port2.close(); resolve(path);
    };
    const timer = setTimeout(() => finish(null), 500);
    ports.port1.onmessage = (event: MessageEvent<{ path?: unknown }>) => finish(typeof event.data?.path === "string" ? event.data.path : null);
    try { client.postMessage({ type: "CHAT_NOTIFICATION_CONTEXT" }, [ports.port2]); }
    catch { finish(null); }
  });
}

export function createNotificationWorker(env: NotificationEnvironment) {
  let pending: Promise<unknown> = Promise.resolve();
  const windows = async () => (await env.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client): client is WindowClient => client.type === "window" && client.frameType === "top-level"
      && new URL(client.url).origin === env.origin);
  const pathOf = async (client: WindowClient) => (await (env.currentPath ?? requestNotificationPath)(client))?.replace(/\/+$/, "") ?? null;
  const foregroundPaths = async () => new Set(await Promise.all((await windows())
    .filter((client) => client.focused && client.visibilityState === "visible").map(pathOf)));
  const notifications = async () => (await env.registration.getNotifications()).filter((item) => item.tag.startsWith(prefix));

  async function handle(command: NotificationCommand, senderId: string): Promise<void> {
    const sender = await env.clients.get(senderId);
    if (!sender || sender.type !== "window" || sender.frameType !== "top-level" || new URL(sender.url).origin !== env.origin) return;
    const control = await readNotificationControl();
    const current = await notifications();
    if (!control.enabled || !control.authorized) { current.forEach((item) => item.close()); return; }
    if (command.kind === "sync") return;
    if (command.kind === "clear-conversations") {
      current.filter((item) => command.ids.includes(item.data?.conversationId)).forEach((item) => item.close()); return;
    }
    if (command.kind === "foreground") {
      const paths = await foregroundPaths();
      current.filter((item) => paths.has(conversationPath(item.data?.conversationId))).forEach((item) => item.close()); return;
    }
    if (command.kind !== "generation" || command.revision !== control.revision) return;
    const candidates = generationNotices(command.sourceId, command.state);
    for (const item of current) {
      if (item.data?.sourceId === command.sourceId && item.data?.generationId === command.state.generationId
        && item.data?.kind === "approval" && !candidates.some((notice) => prefix + notice.key === item.tag)) item.close();
    }
    if (!command.notify) return;
    for (const notice of candidates) {
      if (!await claimNotification(notice.key)) continue;
      // Reading a foreground event counts as handling it, even when another tab replays it later.
      if ((await foregroundPaths()).has(conversationPath(notice.conversationId))) continue;
      const latest = await readNotificationControl();
      if (!latest.enabled || !latest.authorized || latest.revision !== control.revision || !await env.clients.get(senderId)) return;
      await env.registration.showNotification(notice.title, {
        body: notice.body, tag: prefix + notice.key, data: notice,
        icon: "/icons/icon-192-v2.png"
      });
    }
  }

  return {
    handle(command: NotificationCommand, senderId: string): Promise<void> {
      const operation = pending.then(() => handle(command, senderId));
      pending = operation.catch(() => {});
      return operation;
    },
    async click(data: ConversationNotification): Promise<void> {
      if (!data || typeof data.conversationId !== "string") return;
      const path = conversationPath(data.conversationId);
      const clients = await windows();
      const paths = await Promise.all(clients.map(pathOf));
      const target = clients.find((_client, index) => paths[index] === path) ?? clients[0];
      if (target) {
        await target.focus();
        target.postMessage({ type: "CHAT_NOTIFICATION_OPEN", path });
      } else await env.clients.openWindow(new URL(path, env.origin).href);
    }
  };
}
