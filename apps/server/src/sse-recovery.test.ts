import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { EventHub } from "./events";

it("resyncs new/stale connections, replays a valid cursor and releases disconnected listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-chat-sse-recovery-"));
  let password = "";
  let hub!: EventHub;
  let active = 0;
  const original = EventHub.prototype.subscribe;
  const subscribe = vi.spyOn(EventHub.prototype, "subscribe").mockImplementation(function (this: EventHub, after, listener) {
    hub = this; active++;
    const unsubscribe = original.call(this, after, listener);
    return () => { active--; unsubscribe(); };
  });
  const app = await buildApp({ dataFile: join(directory, "db.sqlite"), logger: false,
    webRoot: resolve("apps/web/dist"), skillDiscoveryRoot: join(directory, "skills"),
    authAnnounce: (message) => { password = message.match(/\d{8}/)![0]; } });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-llm-chat-request": "1" }, payload: { password } });
    const cookie = login.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const connect = async (cursor?: string, until = "event: resync") => {
      const controller = new AbortController();
      const response = await fetch(url + "/api/events", { headers: { cookie, ...(cursor === undefined ? {} : { "last-event-id": cursor }) }, signal: controller.signal });
      const reader = response.body!.getReader();
      let body = "";
      const decoder = new TextDecoder();
      while (!body.includes(until) || !body.endsWith("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      controller.abort(); await reader.cancel().catch(() => {});
      await vi.waitFor(() => expect(active).toBe(0));
      return body;
    };
    expect(await connect()).toContain("event: resync");
    for (let i = 0; i < 1200; i++) hub.emit({ type: "plugin", pluginId: `old-${i}`, state: "loaded" });
    const cursor = hub.cursor;
    const fresh = await connect();
    expect(fresh).toContain(`id: ${cursor}\nevent: resync`); expect(fresh).not.toContain("old-");
    expect(await connect("1")).toContain("event: resync");
    expect(await connect("99999")).toContain("event: resync");
    const replay = await connect(String(cursor - 1), "old-1199");
    expect(replay).toContain("old-1199"); expect(replay).not.toContain("event: resync");
    for (let i = 0; i < 20; i++) await connect(String(cursor), "event: generation-snapshot");
    expect(active).toBe(0);
  } finally {
    await app.close(); subscribe.mockRestore(); await rm(directory, { recursive: true, force: true });
  }
});
