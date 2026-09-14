import { test as base } from "@playwright/test";
import { api, APP_URL } from "./helpers.mjs";
import { offlineProxy } from "./offline-proxy";
import { readFile } from "node:fs/promises";
export { expect, type Page, type APIRequestContext } from "@playwright/test";
export const test = base.extend<{ showTour: boolean; isolatedResources: void; network: Awaited<ReturnType<typeof offlineProxy>> | null }>({
  network: async ({ browserName }, use) => {
    if (browserName !== "webkit") { await use(null); return; }
    const proxy = await offlineProxy();
    try { await use(proxy); } finally { await proxy.close(); }
  },
  contextOptions: async ({ contextOptions, network }, use) => {
    await use({ ...contextOptions, ...(network ? { proxy: { server: network.server } } : {}) });
  },
  request: async ({ playwright, storageState, network }, use) => {
    const client = await playwright.request.newContext({ storageState, ...(network ? { proxy: { server: network.server, bypass: "127.0.0.1,localhost" } } : {}) });
    try { await use(client); } finally { await client.dispose(); }
  },
  showTour: [false, { option: true }],
  // Own a request context through teardown, even after a timed-out page is closed.
  isolatedResources: [async ({ playwright, storageState, network }, use) => {
    const client = await playwright.request.newContext({ storageState, ...(network ? { proxy: { server: network.server, bypass: "127.0.0.1,localhost" } } : {}) });
    const collections = ["conversations", "agents", "connections"] as const;
    const before = new Map<string, Set<string>>();
    const settings = await api(client, APP_URL, "GET", "/api/settings");
    for (const key of collections) before.set(key, new Set((await api(client, APP_URL, "GET", `/api/${key}`)).map((item: { id: string }) => item.id)));
    try { await use(); }
    finally {
      try {
        await api(client, APP_URL, "PATCH", "/api/settings", { defaultAgentId: settings.defaultAgentId });
        for (const key of collections) {
          for (const item of await api(client, APP_URL, "GET", `/api/${key}`)) {
            if (before.get(key)!.has(item.id)) continue;
            if (key === "conversations") {
              await api(client, APP_URL, "DELETE", `/api/conversations/${item.id}/queued-messages`);
              const messages = await api(client, APP_URL, "GET", `/api/conversations/${item.id}/messages`);
              for (const message of messages) for (const generation of message.generations) {
                if (["queued", "running", "waiting-approval"].includes(generation.status)) {
                  await api(client, APP_URL, "POST", `/api/generations/${generation.id}/cancel`);
                  await base.expect.poll(async () => (await api(client, APP_URL, "GET", `/api/generations/${generation.id}`)).status).toMatch(/^(stopped|completed|failed)$/);
                }
              }
            }
            await api(client, APP_URL, "DELETE", `/api/${key}/${item.id}`);
          }
        }
      } finally { await client.dispose(); }
    }
  }, { auto: true, timeout: 30_000 }],
  storageState: async ({}, use) => {
    const deadline = Date.now() + 20_000;
    while (true) {
      let token: string | undefined;
      try { token = JSON.parse(await readFile(process.env.E2E_STATE_FILE!, "utf8")).appCookie; } catch {}
      if (token) {
        await use({ cookies: [{ name: "llm_chat_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Strict", expires: -1 }], origins: [] });
        return;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the authenticated app fixture");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  context: async ({ context, showTour, network }, use) => {
    if (!showTour) await context.addInitScript(() => { if (window === window.top) localStorage.setItem("llm-chat.quick-tour.v1", "seen"); });
    if (network) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get() {
          try { return localStorage.getItem("e2e.offline") !== "true"; } catch { return true; }
        } });
      });
      context.setOffline = async value => {
        network.setOffline(value);
        await Promise.all(context.pages().map(page => page.evaluate(offline => {
          try { localStorage.setItem("e2e.offline", String(offline)); } catch {}
          window.dispatchEvent(new Event(offline ? "offline" : "online"));
        }, value)));
      };
    }
    await use(context);
  }
});
