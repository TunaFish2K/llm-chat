import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SERVER_CHANNELS_KEY } from "./server-channel";

let channels: typeof import("./server-channel");
let reload: ReturnType<typeof vi.fn>;
const SERVER = "11111111-1111-4111-8111-111111111111";

async function load(origin = "https://v4.example.com", saved?: unknown) {
  vi.resetModules();
  reload = vi.fn();
  const url = new URL(origin);
  vi.stubGlobal("location", { origin: url.origin, protocol: url.protocol, pathname: "/", reload });
  if (saved !== undefined) localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify(saved));
  channels = await import("./server-channel");
  return channels;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("accepts only other origins of the page's scheme and site", async () => {
  const { parseChannel } = await load();
  expect(parseChannel(" chat.example.com:9443 ")).toEqual({ origin: "https://chat.example.com:9443" });
  expect(parseChannel("https://example.com/path?q=1")).toEqual({ origin: "https://example.com" });
  expect(parseChannel("https://v4.example.com:8443")).toEqual({ origin: "https://v4.example.com:8443" });
  expect(parseChannel("http://chat.example.com:9443")).toEqual({ error: "scheme" });
  expect(parseChannel("https://chat.other.example")).toEqual({ error: "site" });
  expect(parseChannel("https://v4.example.com")).toEqual({ error: "current" });
  for (const input of ["", "ftp://chat.example.com", "https://user:secret@chat.example.com", "https://[bad"]) {
    expect(parseChannel(input)).toEqual({ error: "invalid" });
  }
  const ip = await load("http://192.168.1.5:3000");
  expect(ip.parseChannel("192.168.1.5:4000")).toEqual({ origin: "http://192.168.1.5:4000" });
  expect(ip.parseChannel("http://192.168.1.6:3000")).toEqual({ error: "site" });
});

it("adds, selects and removes channels, reloading only when the active one changes", async () => {
  const { addChannel, selectChannel, removeChannel, apiUrl, assetUrl, apiCredentials, apiBase } = await load();
  expect(addChannel("chat.example.com:9443")).toBeNull();
  expect(addChannel("https://chat.example.com:9443/")).toBe("duplicate");
  expect(addChannel("https://evil.example")).toBe("site");
  expect(addChannel("https://lan.example.com")).toBeNull();
  expect(reload).not.toHaveBeenCalled();
  expect(apiUrl("/api/bootstrap")).toBe("/api/bootstrap");
  expect(apiCredentials()).toBe("same-origin");
  localStorage.setItem("llm-chat.auth-required.v1", "true");
  selectChannel("https://chat.example.com:9443");
  expect(reload).toHaveBeenCalledOnce();
  expect(localStorage.getItem("llm-chat.auth-required.v1")).toBeNull();
  expect(apiBase()).toBe("https://chat.example.com:9443");
  expect(apiUrl("/api/bootstrap")).toBe("https://chat.example.com:9443/api/bootstrap");
  expect(apiCredentials()).toBe("include");
  expect(assetUrl("/api/images/x?v=1")).toBe("https://chat.example.com:9443/api/images/x?v=1");
  expect(assetUrl("/icons/icon.png")).toBe("/icons/icon.png");
  expect(assetUrl(undefined)).toBeUndefined();
  selectChannel("https://chat.example.com:9443");
  selectChannel("https://unknown.example.com");
  removeChannel("https://lan.example.com");
  removeChannel("https://unknown.example.com");
  expect(reload).toHaveBeenCalledOnce();
  removeChannel("https://chat.example.com:9443");
  expect(reload).toHaveBeenCalledTimes(2);
  expect(JSON.parse(localStorage.getItem(SERVER_CHANNELS_KEY)!)).toEqual({ channels: [], active: null, boundServerId: null });
});

it("restores saved channels and drops entries this page cannot use", async () => {
  const { useServerChannels, apiBase } = await load("https://v4.example.com", {
    channels: ["https://chat.example.com:9443", "https://evil.example", 3, "https://chat.example.com:9443"],
    active: "https://evil.example", boundServerId: SERVER
  });
  expect(apiBase()).toBe("");
  expect(channels.parseChannel("chat.example.com:9443")).toEqual({ origin: "https://chat.example.com:9443" });
  expect(useServerChannels).toBeTypeOf("function");
  localStorage.setItem(SERVER_CHANNELS_KEY, "{broken");
  const broken = await load();
  expect(broken.apiBase()).toBe("");
});

it("keeps working in memory when storage fails", async () => {
  const { addChannel, selectChannel, apiBase } = await load();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(addChannel("chat.example.com:9443")).toBeNull();
  selectChannel("https://chat.example.com:9443");
  expect(apiBase()).toBe("https://chat.example.com:9443");
});

it("binds the first server identity and rejects a different one only on another channel", async () => {
  const { acceptServerId, addChannel, selectChannel, resetServerBinding } = await load();
  expect(acceptServerId(null)).toBe(true);
  expect(acceptServerId(SERVER)).toBe(true);
  // The page origin defines the identity; offline data follows its sourceId.
  expect(acceptServerId("other")).toBe(true);
  expect(acceptServerId(SERVER)).toBe(true);
  addChannel("chat.example.com:9443");
  selectChannel("https://chat.example.com:9443");
  expect(acceptServerId(SERVER)).toBe(true);
  expect(acceptServerId("other")).toBe(false);
  expect(channels.useServerChannels).toBeTypeOf("function");
  resetServerBinding();
  expect(acceptServerId("other")).toBe(true);
  expect(acceptServerId(SERVER)).toBe(false);
});

it("verifies the active channel once per page before requests leave", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: SERVER }));
  vi.stubGlobal("fetch", fetcher);
  const { ensureChannelReady, addChannel, selectChannel, resetServerBinding } = await load("https://v4.example.com", { channels: [], active: null, boundServerId: SERVER });
  expect(await ensureChannelReady()).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  addChannel("chat.example.com:9443");
  selectChannel("https://chat.example.com:9443");
  expect(await Promise.all([ensureChannelReady(), ensureChannelReady()])).toEqual([true, true]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("https://chat.example.com:9443/api/identity", { credentials: "include", cache: "no-store" });

  const other = await load("https://v4.example.com", { channels: ["https://chat.example.com:9443"], active: "https://chat.example.com:9443", boundServerId: "other" });
  expect(await other.ensureChannelReady()).toBe(false);
  fetcher.mockRejectedValueOnce(new TypeError("offline"));
  const failing = await load("https://v4.example.com", { channels: ["https://chat.example.com:9443"], active: "https://chat.example.com:9443", boundServerId: SERVER });
  await expect(failing.ensureChannelReady()).rejects.toThrow("offline");
  fetcher.mockResolvedValueOnce(new Response("down", { status: 503 }));
  await expect(failing.ensureChannelReady()).rejects.toThrow("503");
  expect(await failing.ensureChannelReady()).toBe(true);
  void resetServerBinding;
});

it("follows a channel switch made in another tab", async () => {
  // Earlier tests left module instances listening; drive only this one.
  const listen = vi.spyOn(window, "addEventListener") as unknown as { mock: { calls: Array<[string, unknown]> } };
  await load("https://v4.example.com", { channels: ["https://chat.example.com:9443"], active: null, boundServerId: null });
  const storage = listen.mock.calls.find(([type]) => type === "storage")![1] as (event: StorageEvent) => void;
  localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify({ channels: ["https://chat.example.com:9443"], active: null, boundServerId: SERVER }));
  storage(new StorageEvent("storage", { key: SERVER_CHANNELS_KEY }));
  expect(reload).not.toHaveBeenCalled();
  localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify({ channels: ["https://chat.example.com:9443"], active: "https://chat.example.com:9443", boundServerId: SERVER }));
  storage(new StorageEvent("storage", { key: SERVER_CHANNELS_KEY }));
  expect(reload).toHaveBeenCalledOnce();
  expect(channels.apiBase()).toBe("https://chat.example.com:9443");
  storage(new StorageEvent("storage", { key: "unrelated" }));
  expect(reload).toHaveBeenCalledOnce();
});
