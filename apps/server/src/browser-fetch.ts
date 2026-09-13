import { withMessage, errorI18n, type LocalizedMessage } from "@llm-chat/i18n";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { firefox, type BrowserContext, type Browser } from "playwright-core";
import { assertHttpUrl, assertPublicUrl } from "./tools";

const MAX_BYTES = 2 * 1024 * 1024;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

// Resolve once, validate every answer, then pin the actual socket to that answer.
export async function browserResource(url: URL, headers: Record<string, string>, signal: AbortSignal, allowPrivate = false) {
  assertHttpUrl(url);
  const addresses = await abortable(lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }), signal);
  if (!allowPrivate) await assertPublicUrl(url, (async () => addresses) as unknown as typeof lookup);
  signal.throwIfAborted();
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: { ...headers, "accept-encoding": "identity" }, signal,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, addresses)
        : callback(null, addresses[0]!.address, addresses[0]!.family)
    }, (response) => {
      const parts: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { request.destroy(withMessage(new Error("网页资源超过 2 MiB"), "error.the_web_resource_exceeds_2_mib")); return; }
        parts.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 502,
        headers: Object.fromEntries(Object.entries(response.headers)
          .filter(([key, value]) => value !== undefined && !["connection", "transfer-encoding", "content-length"].includes(key))
          .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)])), body: Buffer.concat(parts) }));
    });
    request.on("error", reject);
    request.end();
  });
}

export class BrowserFetchManager {
  private readonly contexts = new Set<BrowserContext>();
  private readonly browsers = new Set<Browser>();
  private active = 0;
  private closing = false;
  private readonly shutdown = new AbortController();
  private lastError: string | null = null;
  private lastErrorI18n: LocalizedMessage | undefined;
  get errorI18n(): LocalizedMessage | undefined { return !existsSync(this.executablePath) ? { key: "runtime.browser_missing" } : this.lastErrorI18n; }
  get executablePath(): string { return firefox.executablePath(); }
  get error(): string | null {
    return !existsSync(this.executablePath)
      ? "浏览器尚未安装：运行 pnpm --filter @llm-chat/server exec playwright-core install firefox"
      : this.lastError;
  }
  get available(): boolean { return existsSync(this.executablePath) && !this.closing; }

  async fetch(rawUrl: string, callerSignal: AbortSignal, allowPrivate = false): Promise<string> {
    callerSignal.throwIfAborted();
    if (!this.available) { const descriptor = this.errorI18n ?? { key: "runtime.browser_closed" as const }; throw withMessage(new Error(this.error ?? "浏览器已关闭"), descriptor.key, descriptor.params); }
    if (this.active >= 2) throw withMessage(new Error("浏览器并发已达上限，请稍后重试"), "error.the_browser_concurrency_limit_has_been_reached_try_again_later");
    this.active++;
    const signal = AbortSignal.any([callerSignal, this.shutdown.signal, AbortSignal.timeout(30_000)]);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let resourceError: string | undefined;
    let resourceI18n: LocalizedMessage | undefined;
    const abort = () => { void browser?.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      assertHttpUrl(new URL(rawUrl));
      if (!allowPrivate) await abortable(assertPublicUrl(new URL(rawUrl), lookup), signal);
      signal.throwIfAborted();
      browser = await firefox.launch({ headless: true, executablePath: this.executablePath, timeout: 10_000,
        firefoxUserPrefs: { "media.peerconnection.enabled": false, "network.dns.disablePrefetch": true, "network.prefetch-next": false } });
      this.browsers.add(browser);
      signal.throwIfAborted();
      context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      this.contexts.add(context);
      await context.routeWebSocket("**/*", (socket) => socket.close());
      let bytes = 0;
      let inFlight = 0;
      let requests = 0;
      await context.route("**/*", async (route) => {
        if (inFlight >= 8 || ++requests > 128) { await route.abort().catch(() => {}); return; }
        inFlight++;
        try {
          const request = route.request();
          if (!["GET", "HEAD"].includes(request.method()) || ["image", "media", "font"].includes(request.resourceType())) {
            await route.abort(); return;
          }
          const resource = await browserResource(new URL(request.url()), await request.allHeaders(), signal, allowPrivate);
          bytes += resource.body.length;
          if (bytes > 8 * MAX_BYTES) throw withMessage(new Error("网页资源总量超过 16 MiB"), "error.web_resources_exceed_16_mib_in_total");
          await route.fulfill(resource);
        } catch (error) {
          if (route.request().isNavigationRequest()) { resourceError = error instanceof Error ? error.message : "网页请求失败"; resourceI18n = errorI18n(error); }
          await route.abort().catch(() => {});
        } finally {
          inFlight--;
        }
      });
      const page = await context.newPage();
      const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
      signal.throwIfAborted();
      if (resourceError) throw new Error(resourceError);
      const text = await page.locator("body").innerText({ timeout: 3000 });
      this.lastError = null;
      this.lastErrorI18n = undefined;
      return JSON.stringify({ url: page.url(), title: await page.title(), status: response?.status(),
        contentType: response?.headers()["content-type"] ?? "text/html", text: text.slice(0, 32 * 1024), truncated: text.length > 32 * 1024 });
    } catch (error) {
      if (signal.aborted) throw withMessage(new Error(callerSignal.aborted ? "浏览器抓取已取消" : this.closing ? "浏览器已关闭" : "浏览器抓取超时（30 秒）"), callerSignal.aborted ? "runtime.browser_canceled" : this.closing ? "runtime.browser_closed" : "runtime.browser_timeout");
      this.lastError = resourceError ?? (error instanceof Error ? error.message : "浏览器抓取失败");
      this.lastErrorI18n = resourceI18n ?? errorI18n(error);
      const wrapped = new Error(this.lastError);
      throw this.lastErrorI18n ? withMessage(wrapped, this.lastErrorI18n.key, this.lastErrorI18n.params) : wrapped;
    } finally {
      signal.removeEventListener("abort", abort);
      if (context) this.contexts.delete(context);
      if (browser) { await browser.close().catch(() => {}); this.browsers.delete(browser); }
      this.active--;
    }
  }
  async close(): Promise<void> {
    this.closing = true; this.shutdown.abort();
    await Promise.allSettled([...this.browsers].map((browser) => browser.close()));
  }
}
