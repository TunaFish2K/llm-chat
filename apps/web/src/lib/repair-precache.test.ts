import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repairPrecache } from "./repair-precache";

class MemoryCache {
  values = new Map<string, Response>();
  put = vi.fn(async (key: string, response: Response) => { this.values.set(key, response.clone()); });
  match = vi.fn(async (key: string) => this.values.get(key)?.clone());
}
let stores: Map<string, MemoryCache>;
let current: MemoryCache;
let fetcher: ReturnType<typeof vi.fn>;
const entries = [{ url: "https://chat.test/index.html", key: "https://chat.test/index.html?revision=new" },
  { url: "https://chat.test/app.js", key: "https://chat.test/app.js", integrity: "sha256-test" }];

beforeEach(async () => {
  stores = new Map(); current = new MemoryCache(); stores.set("app-precache", current);
  await current.put(entries[0]!.key, new Response("corrupt"));
  stores.set("offline-images", new MemoryCache());
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name)!;
    }),
    delete: vi.fn(async (name: string) => stores.delete(name))
  });
  fetcher = vi.fn(async (url: string) => new Response("fresh " + url));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.useRealTimers());

it("replaces corrupted and missing resources while preserving other caches", async () => {
  await repairPrecache("app-precache", entries, async () => {});
  for (const entry of entries) expect(await (await current.match(entry.key))!.text()).toBe("fresh " + entry.url);
  expect(fetcher).toHaveBeenCalledWith(entries[1]!.url, expect.objectContaining({ cache: "reload", credentials: "same-origin", integrity: "sha256-test" }));
  expect([...stores.keys()]).toEqual(["app-precache", "offline-images"]);
});

it("keeps the old cache when any download fails and permits a fresh retry", async () => {
  fetcher.mockResolvedValueOnce(new Response("down", { status: 503 }));
  await expect(repairPrecache("app-precache", entries, async () => {})).rejects.toThrow("503");
  expect(await (await current.match(entries[0]!.key))!.text()).toBe("corrupt");
  expect(await current.match(entries[1]!.key)).toBeUndefined();
  expect(stores.size).toBe(2);
  await repairPrecache("app-precache", entries, async () => {});
  expect(await (await current.match(entries[0]!.key))!.text()).toContain("fresh");
});

it("aborts a stalled download and removes temporary resources", async () => {
  vi.useFakeTimers();
  fetcher.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const outcome = expect(repairPrecache("app-precache", entries, async () => {})).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(90_001);
  await outcome;
  expect(await (await current.match(entries[0]!.key))!.text()).toBe("corrupt");
  expect(stores.size).toBe(2);
});

it("reports a cache write failure and cleans up the staging cache", async () => {
  current.put.mockRejectedValueOnce(new Error("storage full"));
  await expect(repairPrecache("app-precache", entries, async () => {})).rejects.toThrow("storage full");
  expect(stores.size).toBe(2);
});

it("does not report success if the browser evicts a staged resource", async () => {
  const original = caches.open;
  vi.spyOn(caches, "open").mockImplementation(async (name) => {
    const cache = await original(name);
    if (name.includes("-repair-")) vi.mocked(cache.match).mockResolvedValue(undefined);
    return cache;
  });
  await expect(repairPrecache("app-precache", entries, async () => {})).rejects.toThrow("missing");
  expect(stores.size).toBe(2);
});


it("leaves the old cache intact if the release changes while downloading", async () => {
  await expect(repairPrecache("app-precache", entries, async () => { throw new Error("release changed"); })).rejects.toThrow("release changed");
  expect(await (await current.match(entries[0]!.key))!.text()).toBe("corrupt");
  expect(await current.match(entries[1]!.key)).toBeUndefined();
  expect(stores.size).toBe(2);
});
