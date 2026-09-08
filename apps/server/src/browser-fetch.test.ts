import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { BrowserFetchManager, browserResource } from "./browser-fetch";
import { assertPublicUrl } from "./tools";
import { lookup } from "node:dns/promises";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), launch: vi.fn(), exists: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: mocks.exists }));
vi.mock("playwright-core", () => ({ firefox: { executablePath: () => "/test/firefox", launch: mocks.launch } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exists.mockReturnValue(true);
  mocks.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
  respond("<body>rendered</body>");
});

function respond(body: string | Buffer, status = 200, headers = { "content-type": "text/html" }) {
  mocks.request.mockImplementation((_url, options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    request.destroy = (error) => { request.emit("error", error); };
    request.end = () => queueMicrotask(() => {
      if (options.signal.aborted) { request.destroy(new Error("aborted")); return; }
      const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { ...headers, "content-length": "999", connection: "close" } });
      callback(response); response.emit("data", Buffer.from(body)); response.emit("end");
    });
    return request;
  });
}

function browserFixture(text = "rendered by JavaScript") {
  let routeHandler: (route: unknown) => Promise<void>;
  const context = {
    routeWebSocket: vi.fn(), route: vi.fn(async (_pattern, handler) => { routeHandler = handler; }), newPage: vi.fn()
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const navigate = async (url: string, kind = "document", method = "GET") => {
    let resource: { status: number; headers: Record<string, string> } | undefined;
    let aborted = false;
    await routeHandler({
      request: () => ({ method: () => method, resourceType: () => kind, url: () => url,
        allHeaders: async () => ({}), isNavigationRequest: () => kind === "document" }),
      fulfill: async (value: typeof resource) => { resource = value; }, abort: async () => { aborted = true; }
    });
    if (aborted && kind === "document") throw new Error("Navigation aborted");
    return resource;
  };
  const page = {
    goto: vi.fn(async (url) => { const response = await navigate(url); return { status: () => response?.status, headers: () => response?.headers ?? {} }; }),
    waitForLoadState: vi.fn(async () => {}), locator: vi.fn(() => ({ innerText: async () => text })),
    url: () => "https://example.com/", title: async () => "Example"
  };
  context.newPage.mockResolvedValue(page);
  mocks.launch.mockResolvedValue(browser);
  return { browser, context, page, navigate };
}

it("pins a validated DNS answer for both Node lookup modes and strips transport headers", async () => {
  const output = await browserResource(new URL("https://example.com"), { cookie: "a=b" }, new AbortController().signal);
  const options = mocks.request.mock.calls[0]![1];
  const callback = vi.fn();
  options.lookup("example.com", { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.215.14", family: 4 }]);
  options.lookup("example.com", { all: false }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, "93.184.215.14", 4);
  expect(options.headers).toMatchObject({ cookie: "a=b", "accept-encoding": "identity" });
  expect(output.headers).toEqual({ "content-type": "text/html" });
});

it.each(["127.0.0.1", "10.0.0.2", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:7f00:1", "fd00::1", "fe90::1", "ff02::1", "2002:7f00:1::"])("blocks non-public destination %s before opening a socket", async (address) => {
  mocks.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
  await expect(browserResource(new URL("https://example.com"), {}, new AbortController().signal)).rejects.toThrow("blocked");
  expect(mocks.request).not.toHaveBeenCalled();
});

it("rejects credentials, other protocols and mixed public/private DNS answers", async () => {
  await expect(assertPublicUrl(new URL("file:///etc/passwd"), lookup)).rejects.toThrow("HTTP");
  await expect(assertPublicUrl(new URL("https://user:pass@example.com"), lookup)).rejects.toThrow("credentials");
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]);
  await expect(browserResource(new URL("https://example.com"), {}, new AbortController().signal)).rejects.toThrow("blocked");
});

it("bounds each resource and honors a pre-aborted request", async () => {
  respond(Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(browserResource(new URL("https://example.com"), {}, new AbortController().signal)).rejects.toThrow("2 MiB");
  const controller = new AbortController(); controller.abort();
  await expect(browserResource(new URL("https://example.com"), {}, controller.signal)).rejects.toThrow();
});

it("uses an isolated headless context, bounds extracted text and closes its browser", async () => {
  const { browser, context, navigate } = browserFixture("x".repeat(33000));
  const manager = new BrowserFetchManager();
  const result = JSON.parse(await manager.fetch("https://example.com", new AbortController().signal));
  expect(result).toMatchObject({ title: "Example", status: 200, truncated: true });
  expect(result.text).toHaveLength(32768);
  expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
  expect(browser.newContext).toHaveBeenCalledWith({ serviceWorkers: "block", acceptDownloads: false });
  expect(context.routeWebSocket).toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledTimes(1);
  mocks.request.mockClear();
  await navigate("https://example.com/image.png", "image");
  await navigate("https://example.com/post", "fetch", "POST");
  expect(mocks.request).not.toHaveBeenCalled();
  await manager.close();
  expect(manager.available).toBe(false);
});

it("revalidates navigation after initial DNS validation, exposing the actual SSRF error", async () => {
  browserFixture();
  mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  const manager = new BrowserFetchManager();
  await expect(manager.fetch("https://example.com", new AbortController().signal)).rejects.toThrow("blocked");
  expect(manager.error).toContain("blocked");
  expect(mocks.request).not.toHaveBeenCalled();
});

it("reports missing runtime and cleans up when launch completes after cancellation", async () => {
  mocks.exists.mockReturnValue(false);
  const manager = new BrowserFetchManager();
  expect(manager.available).toBe(false);
  await expect(manager.fetch("https://example.com", new AbortController().signal)).rejects.toThrow("install firefox");
  mocks.exists.mockReturnValue(true);
  const { browser } = browserFixture();
  const controller = new AbortController();
  mocks.launch.mockImplementation(async () => { controller.abort(); return browser; });
  await expect(manager.fetch("https://example.com", controller.signal)).rejects.toThrow("已取消");
  expect(browser.close).toHaveBeenCalled();
});

it("bounds concurrent browsers and closes live browsers at shutdown", async () => {
  const { browser, page } = browserFixture();
  const manager = new BrowserFetchManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  page.waitForLoadState.mockImplementation(() => gate);
  const a = manager.fetch("https://example.com", new AbortController().signal);
  const b = manager.fetch("https://example.com", new AbortController().signal);
  await expect(manager.fetch("https://example.com", new AbortController().signal)).rejects.toThrow("并发");
  await vi.waitFor(() => expect(page.waitForLoadState).toHaveBeenCalledTimes(2));
  await manager.close();
  expect(browser.close).toHaveBeenCalled();
  const results = Promise.allSettled([a, b]);
  release();
  expect(await results).toEqual([expect.objectContaining({ status: "rejected" }), expect.objectContaining({ status: "rejected" })]);
});

it("cancels even when DNS resolution never returns", async () => {
  mocks.lookup.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const manager = new BrowserFetchManager();
  const result = manager.fetch("https://example.com", controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow("已取消");
  expect(mocks.launch).not.toHaveBeenCalled();
});
