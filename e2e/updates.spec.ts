import { createServer, request as httpRequest } from "node:http";
import { expect, test, type Page } from "./fixtures";
import { APP_URL } from "./helpers.mjs";

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
}

test("通用设置手动检查更新，离线失败后可以重试", async ({ page, context }) => {
  await page.goto(`${APP_URL}/settings/general`);
  await controlled(page);
  const card = page.getByLabel("应用更新", { exact: true });
  const check = card.getByRole("button", { name: "检查更新", exact: true });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(card.getByRole("status")).toHaveText("已是最新版本");
  await context.setOffline(true);
  try {
    await check.click();
    await expect(card.getByRole("alert")).toContainText("离线");
    await expect(check).toBeEnabled();
  } finally { await context.setOffline(false); }
  await check.click();
  await expect(card.getByRole("status")).toHaveText("已是最新版本");
});

test("下载新版后等待确认，再接管并刷新当前设置页面", async ({ page }) => {
  // Each test owns its origin and worker revisions; the shared app is read-only.
  let revision = 1;
  let rejectAssets = false;
  const source = await (await fetch(`${APP_URL}/sw.js`)).text();
  const proxy = createServer((request, response) => {
    if (rejectAssets && request.url?.startsWith("/assets/")) {
      response.writeHead(503); response.end("download unavailable"); return;
    }
    if (request.url?.split("?")[0] === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      // Older releases intercepted event streams, which keeps Chromium workers alive.
      const legacyEvents = revision < 3 ? 'self.addEventListener("fetch", e => { if(new URL(e.request.url).pathname === "/api/events") e.respondWith(fetch(e.request)); });' : "";
      response.end(`${source}\n${legacyEvents}\nself.addEventListener("message", e => { if(e.data === "e2e-version") e.ports[0].postMessage(${revision}); });`);
      return;
    }
    const upstream = httpRequest(new URL(request.url ?? "/", APP_URL), {
      method: request.method, headers: { ...request.headers, host: new URL(APP_URL).host }
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const url = `http://127.0.0.1:${address.port}/settings/general`;
  try {
    await page.goto(url);
    await controlled(page);
    const card = page.getByLabel("应用更新", { exact: true });
    const check = card.getByRole("button", { name: "检查更新", exact: true });
    await expect(check).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { updateMarker: string }).updateMarker = "not-reloaded"; });
    revision = 2;
    await check.click();
    const apply = card.getByRole("button", { name: "更新并刷新", exact: true });
    await expect(apply).toBeEnabled();
    await expect(card.getByRole("status")).toContainText("新版本已准备好");
    expect(await page.evaluate(() => (window as unknown as { updateMarker: string }).updateMarker)).toBe("not-reloaded");
    await expect(page.locator(".toast-stack").getByRole("button", { name: "更新并刷新" })).toBeEnabled();
    await Promise.all([page.waitForEvent("domcontentloaded"), apply.click()]);
    await expect(page).toHaveURL(url);
    await expect(page.getByLabel("应用更新", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { updateMarker?: string }).updateMarker)).toBeUndefined();
    const activeVersion = await page.evaluate(() => new Promise<number>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller!.postMessage("e2e-version", [channel.port2]);
    }));
    expect(activeVersion).toBe(2);
    // Force update discovers and activates a newer worker without a separate check.
    revision = 3;
    const force = card.getByRole("button", { name: "强制更新", exact: true });
    await Promise.all([page.waitForEvent("domcontentloaded"), force.click()]);
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => new Promise<number>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller!.postMessage("e2e-version", [channel.port2]);
    }))).toBe(3);
    await page.evaluate(() => { (window as unknown as { updateMarker: string }).updateMarker = "still-open"; });
    rejectAssets = true;
    await force.click();
    await expect(card.getByRole("alert")).toContainText("修复失败");
    expect(await page.evaluate(() => (window as unknown as { updateMarker: string }).updateMarker)).toBe("still-open");
    rejectAssets = false;
    await Promise.all([page.waitForEvent("domcontentloaded"), force.click()]);
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(url);

  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  }
});


test("强制更新修复同版本损坏和缺失的缓存，保留登录与本地数据", async ({ page, context }) => {
  await page.goto(`${APP_URL}/settings/general`);
  await controlled(page);
  const card = page.getByLabel("应用更新", { exact: true });
  const force = card.getByRole("button", { name: "强制更新", exact: true });
  await expect(force).toBeEnabled();
  const damaged = await page.evaluate(async () => {
    const name = (await caches.keys()).find(name => name.startsWith("workbox-precache-"))!;
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const index = keys.find(key => new URL(key.url).pathname === "/index.html")!;
    const css = keys.find(key => new URL(key.url).pathname.endsWith(".css"))!;
    await cache.put(index, new Response("BROKEN CACHE", { headers: { "Content-Type": "text/html" } }));
    await cache.delete(css);
    localStorage.setItem("e2e-repair-preference", "keep");
    sessionStorage.setItem("llm-chat.composer.v1.new", JSON.stringify({ text: "保留草稿" }));
    await (await caches.open("another-app-cache")).put("/sentinel", new Response("keep"));
    return { name, index: index.url, css: css.url };
  });
  await context.setOffline(true);
  await force.click();
  await expect(card.getByRole("alert")).toContainText("离线");
  expect(await page.evaluate(async ({ name, index }) => (await (await caches.open(name)).match(index))!.text(), damaged)).toBe("BROKEN CACHE");
  await context.setOffline(false);
  await Promise.all([page.waitForEvent("domcontentloaded"), force.click()]);
  await expect(card).toBeVisible();
  const saved = await page.evaluate(async ({ name, index, css }) => ({
    preference: localStorage.getItem("e2e-repair-preference"),
    draft: sessionStorage.getItem("llm-chat.composer.v1.new"),
    other: await (await (await caches.open("another-app-cache")).match("/sentinel"))!.text(),
    html: await (await (await caches.open(name)).match(index))!.text(),
    css: Boolean(await (await caches.open(name)).match(css))
  }), damaged);
  expect(saved.preference).toBe("keep");
  expect(saved.draft).toContain("保留草稿");
  expect(saved.other).toBe("keep");
  expect(saved.html).not.toContain("BROKEN CACHE");
  expect(saved.css).toBe(true);
});
