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
  const source = await (await fetch(`${APP_URL}/sw.js`)).text();
  const proxy = createServer((request, response) => {
    if (request.url?.split("?")[0] === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      response.end(`${source}\nself.addEventListener("message", e => { if(e.data === "e2e-version") e.ports[0].postMessage(${revision}); });`);
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
    await expect(page.getByLabel("主题")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { updateMarker?: string }).updateMarker)).toBeUndefined();
    const activeVersion = await page.evaluate(() => new Promise<number>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller!.postMessage("e2e-version", [channel.port2]);
    }));
    expect(activeVersion).toBe(2);
  } finally {
    await page.goto("about:blank");
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});
