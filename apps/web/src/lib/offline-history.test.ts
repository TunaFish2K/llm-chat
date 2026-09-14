import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OfflineConversationDto, OfflineManifestDto } from "@llm-chat/contracts";
import { makeConversation, makeMessage, makeSettings } from "../../test/fixtures";
import { clearOfflineHistory, initOfflineHistory, markOffline, offlineRequest, offlineStore, persistOfflineMessages, removeDeletedOfflineHistory, setOfflineEnabled, syncOfflineHistory } from "./offline-history";
import { OFFLINE_IMAGES_PREFIX, offlineRead, offlineWrite, readOfflineManifest, resetOfflineDb, type OfflineControl } from "./offline-db";
import { markConversationsDeleted, setConversationSource } from "./conversation-lifecycle";

const imageUrl = `/api/images/${"a".repeat(8)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(12)}?v=${"b".repeat(64)}`;
const absolute = (input: string | Request) => new URL(typeof input === "string" ? input : input.url, location.origin).href;
class MemoryCache {
  entries = new Map<string, Response>();
  async match(input: string | Request) { return this.entries.get(absolute(input))?.clone(); }
  async put(input: string | Request, response: Response) { this.entries.set(absolute(input), response.clone()); }
  async delete(input: string | Request) { return this.entries.delete(absolute(input)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}
const imageCaches = new Map<string, MemoryCache>();
const cacheStorage = {
  keys: async () => [...imageCaches.keys()],
  delete: async (key: string) => imageCaches.delete(key),
  open: async (key: string) => { let cache = imageCaches.get(key); if (!cache) { cache = new MemoryCache(); imageCaches.set(key, cache); } return cache; }
};
class Channel {
  static instance: Channel;
  onmessage?: (event: { data: unknown }) => void;
  postMessage = vi.fn();
  constructor() { Channel.instance = this; }
}
let manifest: OfflineManifestDto;
let snapshots: Map<string, OfflineConversationDto>;
let network: ReturnType<typeof vi.fn>;
const snapshot = (id: string, text = "saved text", revision = 1): OfflineConversationDto => ({
  sourceId: "source", revision, conversation: makeConversation({ id, title: `Title ${id}` }),
  messages: [makeMessage({ id: `m-${id}`, role: "user", text })]
});
function setSnapshots(...items: OfflineConversationDto[]) {
  snapshots = new Map(items.map(item => [item.conversation.id, item]));
  manifest.conversations = items.map(item => ({ ...item.conversation, cacheRevision: item.revision }));
}
async function start() { initOfflineHistory(); await syncOfflineHistory(); }

beforeEach(async () => {
  await clearOfflineHistory({ logout: true, broadcast: false });
  localStorage.clear(); imageCaches.clear(); setConversationSource("source");
  offlineStore.set({ offline: false });
  await resetOfflineDb({ epoch: "initial", sourceId: "source", enabled: true, authorized: true });
  vi.stubGlobal("caches", cacheStorage); vi.stubGlobal("BroadcastChannel", Channel);
  vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  manifest = { sourceId: "source", settings: makeSettings(), agents: [], connections: [], models: [], conversations: [] } as unknown as OfflineManifestDto;
  setSnapshots(snapshot("one"));
  network = vi.fn(async (path: string) => {
    if (path === "/api/offline/manifest") return Response.json(manifest);
    if (path.startsWith("/api/offline/conversations/")) {
      const value = snapshots.get(path.split("/").at(-1)!);
      return value ? Response.json(value) : Response.json({ error: { code: "conversation_not_found" } }, { status: 404 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => { await clearOfflineHistory({ logout: true, broadcast: false }); });

it("downloads once, reads supported offline routes and refreshes changed revisions", async () => {
  await start();
  expect(offlineStore.get()).toMatchObject({ synced: 1, total: 1, cachedIds: ["one"], error: "" });
  expect(offlineStore.get().lastSync).toBeGreaterThan(0);
  expect(await offlineRequest("/api/bootstrap?conversationId=one")).toMatchObject({ messages: snapshots.get("one")!.messages });
  for (const [path, value] of [["settings", manifest.settings], ["agents", []], ["models", []], ["connections", []], ["conversations", manifest.conversations], ["background-tasks", []]] as const) expect(await offlineRequest(`/api/${path}`)).toEqual(value);
  expect(await offlineRequest("/api/conversations/one/messages")).toEqual(snapshots.get("one")!.messages);
  expect(await offlineRequest("/api/conversations/one/queue")).toEqual({ items: [], paused: true });
  expect(await offlineRequest("/api/conversations/one/queued-messages")).toEqual([]);
  await expect(offlineRequest("/api/conversations/missing/messages")).rejects.toThrow("尚未完成离线同步");
  await expect(offlineRequest("/api/tools")).rejects.toThrow("联网");
  network.mockClear(); await syncOfflineHistory(); expect(network).toHaveBeenCalledTimes(1);
  setSnapshots(snapshot("one", "updated", 2)); await syncOfflineHistory();
  expect(await offlineRequest("/api/conversations/one/messages")).toMatchObject([{ text: "updated" }]);
});

it("caches images, counts bytes and removes unreferenced images and deleted conversations", async () => {
  setSnapshots(snapshot("one", `![image](${imageUrl})`), snapshot("two", "keep"));
  await start();
  const control = (await offlineRead<OfflineControl>("meta", "control"))!;
  const cache = await cacheStorage.open(OFFLINE_IMAGES_PREFIX + control.epoch);
  expect(await cache.match(imageUrl)).toBeDefined();
  expect(offlineStore.get().bytes).toBeGreaterThan(3);
  await cache.put("/api/image-proxy?url=stale", new Response("stale"));
  await syncOfflineHistory(); expect(await cache.match("/api/image-proxy?url=stale")).toBeUndefined();
  markConversationsDeleted(["one"]); await removeDeletedOfflineHistory();
  expect(await offlineRead("conversations", "one")).toBeUndefined();
  expect(await cache.match(imageUrl)).toBeUndefined();
  expect((await readOfflineManifest())?.conversations.map(item => item.id)).toEqual(["two"]);
});

it("keeps previous snapshots on failure, then retries and reconciles server deletions", async () => {
  await start(); const initialSync = offlineStore.get().lastSync;
  setSnapshots(snapshot("one", "new", 2));
  const original = network.getMockImplementation()!;
  network.mockImplementation(async (path: string) => path.endsWith("/one") ? Response.json({}, { status: 503 }) : original(path));
  await syncOfflineHistory();
  expect(offlineStore.get().error).toContain("503"); expect(offlineStore.get().lastSync).toBe(initialSync);
  expect(await offlineRequest("/api/conversations/one/messages")).toMatchObject([{ text: "saved text" }]);
  network.mockImplementation(original); await syncOfflineHistory(); expect(offlineStore.get().error).toBe("");
  setSnapshots(); await syncOfflineHistory(); expect(await offlineRead("conversations", "one")).toBeUndefined();
});

it("ignores a conversation deleted while its snapshot is downloaded", async () => {
  const original = network.getMockImplementation()!;
  network.mockImplementation(async (path: string) => path.endsWith("/one") ? Response.json({ error: { code: "conversation_not_found" } }, { status: 404 }) : original(path));
  await start();
  expect(offlineStore.get().error).toBe(""); expect(await offlineRead("conversations", "one")).toBeUndefined();
  expect((await readOfflineManifest())?.conversations).toEqual([]);
});

it("reports authentication, transport and mismatched-source failures without saving invalid data", async () => {
  const auth = vi.fn(); window.addEventListener("llm-chat:offline-auth-required", auth);
  try {
    network.mockResolvedValueOnce(Response.json({}, { status: 401 })); await start();
    expect(auth).toHaveBeenCalledOnce(); expect(offlineStore.get().error).toContain("登录");
    network.mockRejectedValueOnce(new TypeError("network down")); await syncOfflineHistory();
    expect(offlineStore.get().offline).toBe(true);
    snapshots.get("one")!.sourceId = "other";
    const reconnected = vi.fn(); window.addEventListener("llm-chat:offline-reconnected", reconnected);
    try { await syncOfflineHistory(); expect(reconnected).toHaveBeenCalledOnce(); }
    finally { window.removeEventListener("llm-chat:offline-reconnected", reconnected); }
    expect(await offlineRead("conversations", "one")).toBeUndefined(); expect(offlineStore.get().error).toContain("数据来源");
  } finally { window.removeEventListener("llm-chat:offline-auth-required", auth); }
});

it("reports invalid image responses and storage quota failures, then retries", async () => {
  setSnapshots(snapshot("one", `![image](${imageUrl})`));
  const original = network.getMockImplementation()!;
  network.mockImplementation(async (path: string) => path === imageUrl ? new Response("not image") : original(path));
  await start(); expect(offlineStore.get()).toMatchObject({ imagesMissing: 1, lastSync: 0 });
  network.mockImplementation(original);
  const put = vi.spyOn(MemoryCache.prototype, "put").mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
  await syncOfflineHistory(); expect(offlineStore.get().error).toContain("存储空间"); expect(offlineStore.get().imagesMissing).toBe(1);
  put.mockRestore(); await syncOfflineHistory(); expect(offlineStore.get()).toMatchObject({ error: "", imagesMissing: 0 });
});

it("switches sources without retaining images or messages from the old source", async () => {
  setSnapshots(snapshot("one", `![image](${imageUrl})`)); await start();
  const oldKeys = await caches.keys();
  manifest.sourceId = "replacement"; setSnapshots({ ...snapshot("two"), sourceId: "replacement" });
  await syncOfflineHistory();
  expect(await offlineRead("conversations", "one")).toBeUndefined();
  expect(await offlineRead("conversations", "two")).toMatchObject({ sourceId: "replacement" });
  expect(await caches.keys()).not.toContain(oldKeys[0]);
});

it("disabling storage clears local records but still allows connectivity checks", async () => {
  await start(); await setOfflineEnabled(false);
  expect(await readOfflineManifest()).toBeUndefined(); expect(await caches.keys()).toEqual([]);
  network.mockClear(); markOffline(); await syncOfflineHistory();
  expect(network).toHaveBeenCalledTimes(1); expect(offlineStore.get().offline).toBe(false);
  expect(await readOfflineManifest()).toBeUndefined();
  await setOfflineEnabled(true); expect(await readOfflineManifest()).toBeDefined();
  await clearOfflineHistory({ logout: true }); network.mockClear(); await syncOfflineHistory();
  expect(network).not.toHaveBeenCalled(); await expect(offlineRequest("/api/bootstrap")).rejects.toThrow("本机尚未保存");
});

it("clearing during a download fences a late response", async () => {
  let release!: (response: Response) => void;
  const original = network.getMockImplementation()!;
  network.mockImplementation(async (path: string) => path.endsWith("/one") ? new Promise<Response>(resolve => { release = resolve; }) : original(path));
  initOfflineHistory(); const active = syncOfflineHistory();
  await vi.waitFor(() => expect(release).toBeDefined());
  await clearOfflineHistory({ logout: true }); release(Response.json(snapshots.get("one"))); await active;
  expect(await offlineRead("conversations", "one")).toBeUndefined(); expect(await readOfflineManifest()).toBeUndefined();
  expect(offlineStore.get().syncing).toBe(false);
});

it("persists streaming messages and fences pending writes when cleared", async () => {
  await start();
  persistOfflineMessages("one", [makeMessage({ role: "user", text: "streamed" })], true);
  await vi.waitFor(async () => expect(await offlineRead("conversations", "one")).toMatchObject({ revision: -1, messages: [{ text: "streamed" }] }));
  persistOfflineMessages("one", [makeMessage({ text: "late" })]); await clearOfflineHistory({ logout: true });
  expect(await offlineRead("conversations", "one")).toBeUndefined();
  persistOfflineMessages("one", []); expect(await readOfflineManifest()).toBeUndefined();
});

it("remote clear events invalidate local work and remote logout stops syncing", async () => {
  await start();
  const cleared = vi.fn(), auth = vi.fn();
  window.addEventListener("llm-chat:offline-cleared", cleared); window.addEventListener("llm-chat:offline-auth-required", auth);
  try {
    Channel.instance.onmessage?.({ data: { type: "clear", logout: false } }); expect(cleared).toHaveBeenCalledOnce();
    Channel.instance.onmessage?.({ data: { type: "clear", logout: true } }); expect(auth).toHaveBeenCalledOnce();
    network.mockClear(); await syncOfflineHistory(); expect(network).not.toHaveBeenCalled();
  } finally { window.removeEventListener("llm-chat:offline-cleared", cleared); window.removeEventListener("llm-chat:offline-auth-required", auth); }
});
