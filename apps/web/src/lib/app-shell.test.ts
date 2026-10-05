import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHELL_CACHE_PREFIX, SHELL_PROTOCOL, shellId, type ShellEntry } from "./app-shell";
import { writeAppShell } from "../../scripts/write-app-shell.mjs";

// Fresh modules per test drop the worker's memoized shell state.
let shell: typeof import("./app-shell");
let db: typeof import("./shell-db");
const installShell: typeof shell.installShell = (...args) => shell.installShell(...args);
const activateShell: typeof shell.activateShell = (...args) => shell.activateShell(...args);
const activateStagedShell: typeof shell.activateStagedShell = (...args) => shell.activateStagedShell(...args);
const matchShell: typeof shell.matchShell = (...args) => shell.matchShell(...args);
const parseShellManifest: typeof shell.parseShellManifest = (...args) => shell.parseShellManifest(...args);
const readShellState: typeof db.readShellState = (...args) => db.readShellState(...args);
const updateShellState: typeof db.updateShellState = (...args) => db.updateShellState(...args);

class MemoryCache {
  values = new Map<string, Response>();
  put = vi.fn(async (key: string, response: Response) => { this.values.set(key, response.clone()); });
  match = vi.fn(async (key: string) => this.values.get(key)?.clone());
}
let stores: Map<string, MemoryCache>;
let files: Map<string, Response | (() => Response)>;
let fetcher: ReturnType<typeof vi.fn>;

function integrity(body: string) { return `sha256-${createHash("sha256").update(body).digest("base64")}`; }
async function release(bodies: Record<string, string>, protocol = SHELL_PROTOCOL) {
  const entries: ShellEntry[] = Object.entries(bodies).sort(([a], [b]) => a < b ? -1 : 1).map(([url, body]) => ({ url, integrity: integrity(body) }));
  const manifest = { id: await shellId(protocol, entries), protocol, entries };
  return { manifest, publish(base = "https://channel.test") {
    files.set(`${base}/app-shell.json`, () => Response.json(manifest));
    for (const [url, body] of Object.entries(bodies)) {
      files.set(base + url, () => new Response(body, { headers: { "content-type": url.endsWith(".html") ? "text/html" : "text/javascript",
        "content-security-policy": "default-src 'self'", "set-cookie": "secret=1", "access-control-allow-origin": base } }));
    }
  } };
}

beforeEach(async () => {
  vi.resetModules();
  shell = await import("./app-shell");
  db = await import("./shell-db");
  stores = new Map(); files = new Map();
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name)!;
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    keys: vi.fn(async () => [...stores.keys()])
  });
  fetcher = vi.fn(async (url: string) => {
    const file = files.get(url);
    if (!file) return new Response("missing", { status: 404 });
    return typeof file === "function" ? file() : file;
  });
  vi.stubGlobal("fetch", fetcher);
  await updateShellState(() => ({ current: null, previous: null, staged: null }));
});
afterEach(() => vi.useRealTimers());

it("matches the manifest identity written by the build script", async () => {
  const dist = mkdtempSync(join(tmpdir(), "llm-chat-shell-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "assets/app-12345678.js"), "export {}");
    writeFileSync(join(dist, "sw.js"), "self");
    writeFileSync(join(dist, "large.png"), Buffer.alloc(1024 * 1024 + 1));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const manifest = await writeAppShell(dist, SHELL_PROTOCOL);
    expect(manifest.entries.map((entry) => entry.url)).toEqual(["/assets/app-12345678.js", "/index.html"]);
    expect(manifest.entries[1]!.integrity).toBe(integrity("<html></html>"));
    expect(await parseShellManifest(manifest)).toEqual(manifest);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

it("rejects malformed or tampered manifests and leaves other protocols to the caller", async () => {
  const { manifest } = await release({ "/index.html": "a" });
  await expect(parseShellManifest({ ...manifest, entries: [{ url: "//evil.test/x.js", integrity: "sha256-x" }] })).rejects.toThrow("invalid");
  await expect(parseShellManifest({ ...manifest, entries: [{ url: "/index.html", integrity: "sha256-other" }] })).rejects.toThrow("invalid");
  await expect(parseShellManifest(null)).rejects.toThrow("invalid");
  expect((await parseShellManifest({ ...manifest, protocol: SHELL_PROTOCOL + 1 })).protocol).toBe(SHELL_PROTOCOL + 1);
});

it("downloads a release from a channel with SRI and serves it as page-origin responses", async () => {
  const first = await release({ "/index.html": "<html>one</html>", "/assets/app.js": "one" });
  first.publish();
  expect(await installShell("https://channel.test")).toEqual({ status: "staged", id: first.manifest.id });
  expect(fetcher).toHaveBeenCalledWith("https://channel.test/assets/app.js", expect.objectContaining({
    cache: "reload", mode: "cors", credentials: "omit", integrity: first.manifest.entries[0]!.integrity
  }));
  expect(await installShell("https://channel.test")).toEqual({ status: "staged", id: first.manifest.id });
  expect(await matchShell("/assets/app.js", false)).toBeUndefined();
  await activateShell(first.manifest.id);
  expect(await installShell("https://channel.test")).toEqual({ status: "current", id: first.manifest.id });
  const page = (await matchShell("/settings/general", true))!;
  expect(await page.text()).toBe("<html>one</html>");
  expect(page.headers.get("content-security-policy")).toBe("default-src 'self'");
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(page.headers.get("access-control-allow-origin")).toBeNull();
  expect(await (await matchShell("/", true))!.text()).toBe("<html>one</html>");
  expect(await matchShell("/assets/missing.js", false)).toBeUndefined();
  expect([...stores.keys()]).toEqual([SHELL_CACHE_PREFIX + first.manifest.id]);
});

it("keeps the previous shell for older pages and prunes older generations", async () => {
  const releases = [];
  for (const name of ["one", "two", "three"]) {
    const next = await release({ "/index.html": `<html>${name}</html>`, [`/assets/${name}.js`]: name });
    next.publish();
    await installShell("https://channel.test");
    await activateShell(next.manifest.id);
    releases.push(next.manifest);
  }
  expect((await readShellState()).previous?.id).toBe(releases[1]!.id);
  expect(await (await matchShell("/assets/two.js", false))!.text()).toBe("two");
  expect(await matchShell("/assets/one.js", false)).toBeUndefined();
  expect(await (await matchShell("/", true))!.text()).toBe("<html>three</html>");
  expect([...stores.keys()].sort()).toEqual([releases[1]!.id, releases[2]!.id].map((id) => SHELL_CACHE_PREFIX + id).sort());
  await expect(activateShell(releases[0]!.id)).rejects.toThrow("no longer available");
});

it("keeps the current shell when a download fails and removes staging caches", async () => {
  const first = await release({ "/index.html": "one" });
  first.publish(); await installShell("https://channel.test"); await activateShell(first.manifest.id);
  const second = await release({ "/index.html": "two", "/assets/two.js": "two" });
  second.publish();
  files.set("https://channel.test/assets/two.js", () => new Response("down", { status: 503 }));
  await expect(installShell("https://channel.test")).rejects.toThrow("503");
  expect((await readShellState()).staged).toBeNull();
  expect([...stores.keys()]).toEqual([SHELL_CACHE_PREFIX + first.manifest.id]);
  files.set("https://channel.test/app-shell.json", () => new Response("down", { status: 502 }));
  await expect(installShell("https://channel.test")).rejects.toThrow("502");
  expect(await (await matchShell("/", true))!.text()).toBe("one");
});

it("reports a newer protocol without downloading it", async () => {
  const next = await release({ "/index.html": "next" }, SHELL_PROTOCOL + 1);
  next.publish();
  expect(await installShell("https://channel.test")).toEqual({ status: "protocol", protocol: SHELL_PROTOCOL + 1 });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("re-downloads the current shell on force to repair evicted files", async () => {
  const first = await release({ "/index.html": "one" });
  first.publish(); await installShell("https://channel.test"); await activateShell(first.manifest.id);
  stores.get(SHELL_CACHE_PREFIX + first.manifest.id)!.values.clear();
  expect(await matchShell("/", true)).toBeUndefined();
  expect(await installShell("https://channel.test", { force: true })).toEqual({ status: "current", id: first.manifest.id });
  expect(await (await matchShell("/", true))!.text()).toBe("one");
});

it("aborts a stalled download", async () => {
  const first = await release({ "/index.html": "one" });
  let stalled!: () => void;
  const started = new Promise<void>((resolve) => { stalled = resolve; });
  fetcher.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith("app-shell.json")) return Response.json(first.manifest);
    stalled();
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
  });
  // IndexedDB runs on real timers; only the download deadline is faked.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(installShell("https://channel.test")).rejects.toThrow("timed out");
  await started;
  await vi.advanceTimersByTimeAsync(90_001);
  await outcome;
  expect(stores.size).toBe(0);
});

it("adopts the staged shell when a new worker activates and drops leftovers", async () => {
  const first = await release({ "/index.html": "one" });
  first.publish(); await installShell("https://channel.test");
  stores.set(`${SHELL_CACHE_PREFIX}staging-leftover`, new MemoryCache());
  stores.set(`${SHELL_CACHE_PREFIX}${"0".repeat(64)}`, new MemoryCache());
  await activateStagedShell();
  expect((await readShellState()).current?.id).toBe(first.manifest.id);
  expect([...stores.keys()]).toEqual([SHELL_CACHE_PREFIX + first.manifest.id]);
  await updateShellState((state) => ({ ...state, staged: { ...first.manifest, id: "f".repeat(64), protocol: SHELL_PROTOCOL + 1 } }));
  await activateStagedShell();
  expect(await readShellState()).toMatchObject({ current: { id: first.manifest.id }, staged: null });
});
