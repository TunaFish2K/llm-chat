import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { agentInput, api, APP_URL, AUTH_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

type Override = (request: IncomingMessage, response: ServerResponse) => boolean;
interface Proxy { origin: string; requests: string[]; down: boolean; override: Override | null; close(): Promise<void> }

/**
 * Another network entrance of a server. It keeps the browser's Host header,
 * so the server sees the channel address exactly as a reverse proxy would.
 */
async function channelProxy(target: string): Promise<Proxy> {
  const upstream = new URL(target);
  const proxy: Proxy = { origin: "", requests: [], down: false, override: null, close: async () => {} };
  const server = createServer((incoming, outgoing) => {
    proxy.requests.push(`${incoming.method} ${incoming.url}`);
    if (proxy.down) { outgoing.writeHead(502); outgoing.end("channel down"); return; }
    if (proxy.override?.(incoming, outgoing)) return;
    const forwarded = httpRequest({ host: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return proxy;
}

async function setup(request: APIRequestContext, baseUrl: string) {
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: `channel-${Date.now()}`, baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`channel-${Date.now()}`, model.id));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  return { conversation };
}

async function addChannel(page: Page, origin: string) {
  const card = page.getByLabel("服务器通道", { exact: true });
  await card.getByLabel("通道地址").fill(origin);
  await card.getByRole("button", { name: "添加", exact: true }).click();
  await expect(card.getByRole("radio", { name: origin })).toBeVisible();
  return card;
}

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
}

const sri = (body: string | Buffer) => `sha256-${createHash("sha256").update(body).digest("base64")}`;

test("页面地址不可达时，经同一服务器的其他通道聊天并更新", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: "经通道送达的回复" });
  const fixture = await setup(request, provider.baseUrl);
  const home = await channelProxy(APP_URL);
  const channel = await channelProxy(APP_URL);
  try {
    await page.goto(`${home.origin}/settings/general`, { waitUntil: "domcontentloaded" });
    await controlled(page);
    const card = await addChannel(page, channel.origin);
    await Promise.all([page.waitForEvent("domcontentloaded"), card.getByRole("radio", { name: channel.origin }).check()]);
    await expect(page.getByLabel("服务器通道", { exact: true })).toBeVisible();

    // The installed page origin goes away; the cached shell still starts the app.
    home.down = true; home.requests.length = 0;
    await page.goto(`${home.origin}/c/${fixture.conversation.id}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("输入消息").fill("通道消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('.msg[data-role="assistant"]').last()).toContainText("经通道送达的回复");
    expect(home.requests.filter((line) => line.includes("/api/"))).toEqual([]);
    expect(channel.requests).toEqual(expect.arrayContaining([
      expect.stringMatching(/^GET \/api\/identity/), expect.stringMatching(/^GET \/api\/events/), expect.stringMatching(/^POST \/api\/conversations\/[^/]+\/messages/)
    ]));

    // A release published through the channel installs while the page origin stays down.
    const shell = await (await fetch(`${APP_URL}/app-shell.json`)).json() as { protocol: number; entries: Array<{ url: string; integrity: string }> };
    const html = (await (await fetch(`${APP_URL}/index.html`)).text()).replace("<head>", '<head><meta name="e2e-release" content="channel">');
    const entries = shell.entries.map((entry) => entry.url === "/index.html" ? { ...entry, integrity: sri(html) } : entry);
    const next = { id: createHash("sha256").update(JSON.stringify({ protocol: shell.protocol, entries })).digest("hex"), protocol: shell.protocol, entries };
    let protocol = shell.protocol;
    channel.override = (incoming, outgoing) => {
      const path = incoming.url?.split("?")[0];
      const cors = { "access-control-allow-origin": incoming.headers.origin ?? "*", "cache-control": "no-store" };
      if (path === "/app-shell.json") {
        outgoing.writeHead(200, { ...cors, "content-type": "application/json" });
        outgoing.end(JSON.stringify({ ...next, protocol }));
        return true;
      }
      if (path === "/index.html") { outgoing.writeHead(200, { ...cors, "content-type": "text/html" }); outgoing.end(html); return true; }
      return false;
    };
    await page.goto(`${home.origin}/settings/general`, { waitUntil: "domcontentloaded" });
    const updates = page.getByLabel("应用更新", { exact: true });
    await updates.getByRole("button", { name: "检查更新", exact: true }).click();
    const apply = updates.getByRole("button", { name: "更新并刷新", exact: true });
    await expect(apply).toBeEnabled();
    await Promise.all([page.waitForEvent("domcontentloaded"), apply.click()]);
    await expect(page.locator('meta[name="e2e-release"]')).toHaveAttribute("content", "channel");

    // A worker protocol change cannot be installed from another channel.
    protocol = shell.protocol + 1;
    await page.getByLabel("应用更新", { exact: true }).getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(page.getByLabel("应用更新", { exact: true }).getByRole("alert")).toContainText(home.origin);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await home.close(); await channel.close(); await provider.close(); }
  }
});

test("拒绝报告其他服务器标识的通道且不发送业务请求", async ({ page }) => {
  const home = await channelProxy(APP_URL);
  // Same site as the page, but a different server instance behind it.
  const stranger = await channelProxy(AUTH_URL);
  try {
    await page.goto(`${home.origin}/settings/general`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("服务器通道", { exact: true })).toContainText("已绑定服务器");
    const card = await addChannel(page, stranger.origin);
    await card.getByLabel("通道地址").fill("http://localhost:1");
    await card.getByRole("button", { name: "添加", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("同一站点");
    stranger.requests.length = 0;
    await Promise.all([page.waitForEvent("domcontentloaded"), card.getByRole("radio", { name: stranger.origin }).check()]);
    const channels = page.getByLabel("服务器通道", { exact: true });
    await expect(channels.getByText("不是同一台服务器")).toBeVisible();
    expect(stranger.requests.filter((line) => line.includes("/api/") && !line.startsWith("GET /api/identity"))).toEqual([]);
    // Leaving the wrong channel needs no server.
    await Promise.all([page.waitForEvent("domcontentloaded"), channels.getByRole("radio", { name: /当前地址/ }).check()]);
    await expect(page.getByLabel("服务器通道", { exact: true })).toContainText("已绑定服务器");
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await home.close(); await stranger.close(); }
  }
});
