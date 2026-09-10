import { conversationDeleted, deletedConversationIds, deletionRevision, markConversationsDeleted, setConversationSource } from "./conversation-lifecycle";
import { draftImageUrls } from "./composer-draft-storage";
import type { MessageDto, OfflineConversationDto, OfflineManifestDto } from "@llm-chat/contracts";
import { createStore } from "./store";
import { OFFLINE_IMAGES_PREFIX, offlineConversations, offlineRead, offlineWrite, readOfflineManifest, resetOfflineDb, type OfflineControl } from "./offline-db";

export const offlineStore = createStore({
  offline: false, enabled: true, syncing: false, synced: 0, total: 0,
  lastSync: 0, bytes: 0, imagesMissing: 0, error: "", cachedIds: [] as string[]
});
let run: Promise<void> | null = null;
let syncAgain = false;
let controller: AbortController | null = null;
let initialized = false;
let authenticated = false;
let broadcast: BroadcastChannel | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const pendingMessages = new Map<string, MessageDto[]>();

function enabledPreference(): boolean { try { return localStorage.getItem("llm-chat.offline-enabled") !== "false"; } catch { return true; } }
function failure(error: unknown): void {
  offlineStore.set({ error: error instanceof DOMException && error.name === "QuotaExceededError" ? "存储空间不足，部分记录或图片尚未保存" : error instanceof Error ? error.message : "离线记录保存失败" });
}
export function markOffline(): void {
  offlineStore.set({ offline: true });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (authenticated && navigator.onLine) void syncOfflineHistory(); }, 3_000);
}
export function isOffline(): boolean { return offlineStore.get().offline; }

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: "no-store" });
  if (response.status === 401) { window.dispatchEvent(new Event("llm-chat:offline-auth-required")); throw new Error("请重新登录"); }
  if (response.status === 404) {
    const body = await response.clone().json().catch(() => null);
    const id = path.match(/^\/api\/offline\/conversations\/([^/]+)/)?.[1];
    if (id && body?.error?.code === "conversation_not_found") markConversationsDeleted([id]);
  }
  if (!response.ok) throw new Error(`同步失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}
async function controlFor(sourceId: string, signal: AbortSignal): Promise<OfflineControl> {
  const old = await offlineRead<OfflineControl>("meta", "control");
  signal.throwIfAborted();
  if (old?.sourceId === sourceId && old.authorized && old.enabled) return old;
  const control = { epoch: crypto.randomUUID(), sourceId, enabled: true, authorized: true };
  await resetOfflineDb(control);
  await deleteImageCaches(control.epoch);
  return control;
}
async function deleteImageCaches(keepEpoch?: string): Promise<void> {
  if (typeof caches === "undefined") return;
  for (const key of await caches.keys()) if (key.startsWith(OFFLINE_IMAGES_PREFIX) && key !== OFFLINE_IMAGES_PREFIX + keepEpoch) await caches.delete(key);
}

/** Only download image URLs already supported by the chat renderer. */
export function historyImageUrls(messages: MessageDto[]): string[] {
  const urls = new Set<string>();
  const add = (value: string) => {
    if (/^\/api\/(?:images|files)\/[\da-f-]{36}\?v=[\da-f]{64}$/i.test(value)) urls.add(value);
    else { try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol)) urls.add(`/api/image-proxy?url=${encodeURIComponent(url.href)}`); } catch {} }
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && (record.kind === "image" || String(record.mimeType).startsWith("image/"))) add(record.url);
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === "string" && ["text", "content", "detailMarkdown", "summary"].includes(key)) {
        for (const match of child.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) add(match[1]!);
        for (const match of child.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(match[1]!);
      } else if (typeof child === "object") visit(child);
    }
  };
  visit(messages);
  return [...urls];
}

async function updateStats(): Promise<void> {
  const manifest = await readOfflineManifest();
  const snapshots = await offlineConversations();
  const valid = snapshots.filter((item) => item.sourceId === manifest?.sourceId && !conversationDeleted(item.conversation.id));
  const ids = new Set(manifest?.conversations.filter((item) => !conversationDeleted(item.id)).map((item) => item.id));
  let bytes = new Blob([JSON.stringify(manifest ?? {}), ...valid.map((item) => JSON.stringify(item))]).size;
  const control = await offlineRead<OfflineControl>("meta", "control");
  if (control?.authorized && control.enabled && manifest && typeof caches !== "undefined") {
    const cache = await caches.open(OFFLINE_IMAGES_PREFIX + control.epoch);
    for (const request of await cache.keys()) { const response = await cache.match(request); if (response) bytes += (await response.blob()).size; }
  }
  offlineStore.set({ synced: valid.filter((item) => ids.has(item.conversation.id)).length, total: ids.size,
    cachedIds: valid.map((item) => item.conversation.id), lastSync: await offlineRead<number>("meta", "lastSync") ?? 0, bytes });
}

export function syncOfflineHistory(): Promise<void> {
  if (run) return run;
  if (!authenticated || navigator.onLine === false) return Promise.resolve();
  controller = new AbortController();
  const signal = controller.signal;
  run = (async () => {
    offlineStore.set({ syncing: true, error: "", imagesMissing: 0 });
    try {
      const revision = deletionRevision();
      const requestedId = location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
      const knownSnapshots = typeof indexedDB !== "undefined" && enabledPreference() ? await offlineConversations() : [];
      const manifest = await fetchJson<OfflineManifestDto>("/api/offline/manifest", signal);
      signal.throwIfAborted();
      setConversationSource(manifest.sourceId);
      if (revision === deletionRevision()) window.dispatchEvent(new CustomEvent("llm-chat:conversation-manifest", { detail: { conversations: manifest.conversations, currentId: requestedId, knownIds: knownSnapshots.filter((item) => item.sourceId === manifest.sourceId).map((item) => item.conversation.id) } }));
      manifest.conversations = manifest.conversations.filter((item) => !conversationDeleted(item.id));
      if (!enabledPreference()) {
        const wasOffline = isOffline();
        offlineStore.set({ offline: false });
        if (wasOffline) window.dispatchEvent(new Event("llm-chat:offline-reconnected"));
        return;
      }
      const control = await controlFor(manifest.sourceId, signal);
      signal.throwIfAborted();
      const old = new Map((await offlineConversations()).map((item) => [item.conversation.id, item]));
      const ids = new Set(manifest.conversations.map((item) => item.id));
      if (revision === deletionRevision()) markConversationsDeleted(knownSnapshots.filter((item) => item.sourceId === manifest.sourceId && !ids.has(item.conversation.id)).map((item) => item.conversation.id));
      if (!await offlineWrite(control.epoch, (tx) => {
        tx.objectStore("meta").put({ ...manifest, conversations: manifest.conversations.filter((item) => !conversationDeleted(item.id)) }, "manifest");
        for (const id of old.keys()) if (!ids.has(id)) tx.objectStore("conversations").delete(id);
      })) return;
      const wasOffline = isOffline();
      offlineStore.set({ offline: false, total: ids.size });
      if (wasOffline) window.dispatchEvent(new Event("llm-chat:offline-reconnected"));
      const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
      const queue = [...manifest.conversations].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId) || b.updatedAt - a.updatedAt);
      const urls = new Set<string>(draftImageUrls());
      let completed = 0;
      const worker = async () => {
        while (queue.length) {
          signal.throwIfAborted();
          const conversation = queue.shift()!;
          if (conversationDeleted(conversation.id)) continue;
          let snapshot = old.get(conversation.id);
          if (!snapshot || snapshot.revision !== conversation.cacheRevision || snapshot.sourceId !== manifest.sourceId) {
            try {
              snapshot = await fetchJson<OfflineConversationDto>(`/api/offline/conversations/${conversation.id}`, signal);
              if (snapshot.sourceId !== manifest.sourceId) throw new Error("数据来源已改变，请重新同步");
              if (!await offlineWrite(control.epoch, (tx) => { if (!conversationDeleted(conversation.id)) tx.objectStore("conversations").put(snapshot!); })) return;
            } catch (error) {
              if (signal.aborted) throw error;
              if (conversationDeleted(conversation.id)) continue;
              if (snapshot) historyImageUrls(snapshot.messages).forEach((url) => urls.add(url));
              failure(error); continue;
            }
          }
          if (conversationDeleted(conversation.id)) continue;
          historyImageUrls(snapshot.messages).forEach((url) => urls.add(url));
          completed += 1;
          offlineStore.set({ synced: completed });
        }
      };
      await Promise.all([worker(), worker()]);
      signal.throwIfAborted();
      if (typeof caches !== "undefined") {
        const cache = await caches.open(OFFLINE_IMAGES_PREFIX + control.epoch);
        draftImageUrls().forEach((url) => urls.add(url));
        for (const request of await cache.keys()) if (!urls.has(new URL(request.url).pathname + new URL(request.url).search)) await cache.delete(request);
        for (const url of urls) {
          signal.throwIfAborted();
          if (await cache.match(url)) continue;
          try {
            const response = await fetch(url, { credentials: "same-origin", signal });
            if (response.status === 401) window.dispatchEvent(new Event("llm-chat:offline-auth-required"));
            if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("图片尚未下载");
            signal.throwIfAborted();
            await cache.put(url, response);
          } catch (error) {
            if (signal.aborted) throw error;
            offlineStore.set({ imagesMissing: offlineStore.get().imagesMissing + 1 });
            failure(error);
            if (error instanceof DOMException && error.name === "QuotaExceededError") break;
          }
        }
      }
      if (!offlineStore.get().error) await offlineWrite(control.epoch, (tx) => tx.objectStore("meta").put(Date.now(), "lastSync"));
      await removeDeletedOfflineHistory();
      await updateStats();
    } catch (error) {
      if (!signal.aborted) { if (error instanceof TypeError || navigator.onLine === false) markOffline(); failure(error); }
    } finally {
      offlineStore.set({ syncing: false }); run = null; controller = null;
      if (syncAgain && !signal.aborted) { syncAgain = false; void syncOfflineHistory(); }
    }
  })();
  return run;
}

export async function clearOfflineHistory(options: { disable?: boolean; logout?: boolean; broadcast?: boolean } = {}): Promise<void> {
  controller?.abort();
  clearTimeout(reconnectTimer);
  clearTimeout(persistTimer); pendingMessages.clear();
  if (options.logout) authenticated = false;
  if (options.disable) { try { localStorage.setItem("llm-chat.offline-enabled", "false"); } catch {} }
  await resetOfflineDb({ epoch: crypto.randomUUID(), sourceId: null, enabled: enabledPreference(), authorized: !options.logout });
  await deleteImageCaches();
  offlineStore.set({ enabled: enabledPreference(), synced: 0, total: 0, bytes: 0, lastSync: 0, cachedIds: [], error: "", imagesMissing: 0 });
  if (options.broadcast !== false) broadcast?.postMessage({ type: "clear", logout: options.logout ?? false });
  window.dispatchEvent(new Event("llm-chat:offline-cleared"));
}
export async function setOfflineEnabled(enabled: boolean): Promise<void> {
  try { localStorage.setItem("llm-chat.offline-enabled", String(enabled)); } catch {}
  offlineStore.set({ enabled });
  if (enabled) await syncOfflineHistory(); else await clearOfflineHistory({ disable: true });
}
export function initOfflineHistory(): void {
  authenticated = true;
  offlineStore.set({ enabled: enabledPreference() });
  if (!initialized) {
    initialized = true;
    if (typeof BroadcastChannel !== "undefined") {
      broadcast = new BroadcastChannel("llm-chat-offline-history");
      broadcast.onmessage = (event) => {
        if (event.data?.type === "clear") {
          controller?.abort(); clearTimeout(persistTimer); pendingMessages.clear();
          if (event.data.logout) authenticated = false;
          void updateStats().catch(failure);
          offlineStore.set({ enabled: enabledPreference() });
          window.dispatchEvent(new CustomEvent(event.data.logout ? "llm-chat:offline-auth-required" : "llm-chat:offline-cleared", { detail: { remote: true } }));
        }
      };
    }
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", () => void syncOfflineHistory());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void syncOfflineHistory(); });
    setInterval(() => { if (document.visibilityState === "visible") void syncOfflineHistory(); }, 60_000);
  }
  void updateStats().catch(failure);
  void syncOfflineHistory();
}

export function persistOfflineMessages(id: string, messages: MessageDto[], immediate = false): void {
  if (conversationDeleted(id) || typeof indexedDB === "undefined" || !enabledPreference() || isOffline()) return;
  pendingMessages.set(id, messages);
  if (persistTimer && !immediate) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = undefined; void (async () => {
    const control = await offlineRead<OfflineControl>("meta", "control");
    if (!control?.authorized || !control.enabled) { pendingMessages.clear(); return; }
    const pending = [...pendingMessages]; pendingMessages.clear();
    for (const [conversationId, content] of pending) {
      if (conversationDeleted(conversationId)) continue;
      const old = await offlineRead<OfflineConversationDto>("conversations", conversationId);
      if (!old) { if (run) syncAgain = true; else void syncOfflineHistory(); }
      if (old) await offlineWrite(control.epoch, (tx) => { if (!conversationDeleted(conversationId)) tx.objectStore("conversations").put({ ...old, messages: content, revision: -1 }); });
    }
  })().catch(failure); }, immediate ? 0 : 500);
}

export async function offlineRequest(path: string): Promise<unknown> {
  const manifest = await readOfflineManifest();
  if (!manifest) throw new Error("本机尚未保存离线记录，请联网后同步");
  manifest.conversations = manifest.conversations.filter((item) => !conversationDeleted(item.id));
  const url = new URL(path, location.origin);
  const route = url.pathname;
  if (route === "/api/bootstrap") {
    const id = url.searchParams.get("conversationId");
    const snapshot = id && !conversationDeleted(id) ? await offlineRead<OfflineConversationDto>("conversations", id) : undefined;
    return { ...manifest, ...(snapshot ? { messages: snapshot.messages } : {}) };
  }
  if (route === "/api/settings") return manifest.settings;
  if (route === "/api/agents") return manifest.agents;
  if (route === "/api/models") return manifest.models;
  if (route === "/api/connections") return manifest.connections;
  if (route === "/api/conversations") return manifest.conversations;
  if (route === "/api/conversations/search") {
    const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase();
    if (!query) return [];
    const snapshots = await offlineConversations();
    const matches = new Map<string, { conversationId: string; title: string; snippet: string; updatedAt: number; titleMatch: boolean }>();
    for (const snapshot of snapshots) {
      const conversation = manifest.conversations.find((item) => item.id === snapshot.conversation.id);
      if (!conversation || snapshot.sourceId !== manifest.sourceId) continue;
      const titleMatch = conversation.title.toLocaleLowerCase().includes(query);
      const content = snapshot.messages.map((message) => message.role === "user" ? message.text ?? "" : message.generations.find((item) => item.id === message.activeGenerationId)?.blocks.filter((block) => ["text", "refusal"].includes(block.type)).map((block) => block.content).join("") ?? message.text ?? "").join("\n");
      const position = content.toLocaleLowerCase().indexOf(query);
      if (position >= 0) matches.set(conversation.id, { conversationId: conversation.id, title: conversation.title, snippet: position < 0 ? "" : content.slice(Math.max(0, position - 80), Math.max(0, position - 80) + 240), updatedAt: conversation.updatedAt, titleMatch });
    }
    const downloaded = new Set(snapshots.map((item) => item.conversation.id));
    for (const conversation of manifest.conversations) {
      if (conversation.forkedFrom || !conversation.title.toLocaleLowerCase().includes(query)) continue;
      const id = conversation.activeBranchId ?? conversation.id;
      if (!downloaded.has(id)) continue;
      matches.set(id, { conversationId: id, title: conversation.title, snippet: matches.get(id)?.snippet ?? "", updatedAt: conversation.updatedAt, titleMatch: true });
    }
    return [...matches.values()].sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId)).slice(0, 50);
  }
  const messageMatch = route.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch) {
    const snapshot = await offlineRead<OfflineConversationDto>("conversations", messageMatch[1]!);
    if (snapshot?.sourceId === manifest.sourceId && !conversationDeleted(messageMatch[1]!)) return snapshot.messages;
    throw new Error("此会话尚未完成离线同步，请联网后再试");
  }
  if (/\/queue$/.test(route)) return { items: [], paused: true };
  if (/\/queued-messages$/.test(route) || route === "/api/background-tasks") return [];
  throw new Error("此内容需要联网查看");
}

/** Read and delete in one transaction so a stale manifest cannot overwrite newer cache metadata. */
export async function removeDeletedOfflineHistory(): Promise<void> {
  if (typeof indexedDB === "undefined" || !deletedConversationIds().length) return;
  const control = await offlineRead<OfflineControl>("meta", "control");
  if (!control?.authorized || !control.enabled) return;
  await offlineWrite(control.epoch, (tx) => {
    const request = tx.objectStore("meta").get("manifest");
    request.onsuccess = () => {
      const manifest = request.result as OfflineManifestDto | undefined;
      if (manifest) tx.objectStore("meta").put({ ...manifest, conversations: manifest.conversations.filter((item) => !conversationDeleted(item.id)) }, "manifest");
    };
    for (const id of deletedConversationIds()) { pendingMessages.delete(id); tx.objectStore("conversations").delete(id); }
  });
  if (typeof caches !== "undefined") {
    const snapshots = await offlineConversations();
    const urls = new Set([...draftImageUrls(), ...snapshots.filter((item) => !conversationDeleted(item.conversation.id)).flatMap((item) => historyImageUrls(item.messages))]);
    const cache = await caches.open(OFFLINE_IMAGES_PREFIX + control.epoch);
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (!urls.has(url.pathname + url.search)) await cache.delete(request);
    }
  }
}
window.addEventListener("llm-chat:conversations-deleted", () => {
  if (typeof indexedDB === "undefined") return;
  // Let the synchronous app handler preserve attachments before cache collection.
  void Promise.resolve().then(removeDeletedOfflineHistory).then(updateStats).catch(failure);
});
