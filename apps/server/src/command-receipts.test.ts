import Fastify from "fastify";
import compress from "@fastify/compress";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "./database";
import { StoreError } from "./errors";
import { cleanupStores, createStore } from "./test-helpers";
import { registerCommandReceipts } from "./command-receipts";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); cleanupStores(); });

async function fixture(store = createStore()) {
  const app = Fastify(); apps.push(app);
  await app.register(compress, { threshold: 1 });
  app.decorateRequest("authIdentity", null);
  app.addHook("onRequest", async request => {
    if (request.headers["x-session"] !== "none") request.authIdentity = { sessionId: String(request.headers["x-session"] ?? "test"), expiresAt: Date.now() + 60_000, refreshCookie: false };
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof StoreError ? 409 : 500).send({ error: { code: error instanceof StoreError ? error.code : "internal_error" } }));
  registerCommandReceipts(app, store);
  return { app, store };
}

it("replays a durable JSON result after restart and rejects changed input", async () => {
  const { app, store } = await fixture();
  const command = vi.fn(() => ({ value: "once" }));
  app.post("/api/command", command);
  const id = randomUUID();
  const options = { method: "POST" as const, url: "/api/command", headers: { "x-llm-chat-request-id": id }, payload: { text: "same" } };
  expect((await app.inject(options)).json()).toEqual({ value: "once" });
  expect((await app.inject(options)).json()).toEqual({ value: "once" });
  expect((await app.inject({ ...options, payload: { text: "changed" } })).statusCode).toBe(409);
  expect(command).toHaveBeenCalledTimes(1);
  await app.close(); store.close();
  const reopened = new Store(join(store.dataDir, "test.sqlite"));
  try {
    const next = await fixture(reopened); next.app.post("/api/command", command);
    expect((await next.app.inject(options)).json()).toEqual({ value: "once" });
    expect(command).toHaveBeenCalledTimes(1);
    await next.app.close();
  } finally { reopened.close(); }
});

it("joins concurrent requests, while keeping independent sessions separate", async () => {
  const { app } = await fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const command = vi.fn(async () => { await gate; return { ok: true }; }); app.post("/api/command", command);
  const options = { method: "POST" as const, url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID() }, payload: {} };
  const first = app.inject(options); await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  const second = app.inject(options); release();
  const responses = await Promise.all([first, second]);
  expect(responses.map(response => response.json())).toEqual([{ ok: true }, { ok: true }]);
  expect(command).toHaveBeenCalledTimes(1);
  await app.inject({ ...options, headers: { ...options.headers, "x-session": "other" } });
  expect(command).toHaveBeenCalledTimes(2);
});

it("never reruns an unfinished command after a crash", async () => {
  const { app, store } = await fixture();
  const id = randomUUID(); store.acceptSubmission(id, "command:test:POST:/api/command", {}, () => ({ pending: true, createdAt: Date.now() }));
  const command = vi.fn(() => ({ ok: true })); app.post("/api/command", command);
  const response = await app.inject({ method: "POST", url: "/api/command", headers: { "x-llm-chat-request-id": id }, payload: {} });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe("request_unconfirmed"); expect(command).not.toHaveBeenCalled();
});

it.each(["json", "text", "empty", "failure"])("retains the original %s response without rerunning effects", async kind => {
  const { app } = await fixture();
  const command = vi.fn((_request, reply) => {
    if (kind === "failure") throw new Error("after side effects");
    if (kind === "empty") return reply.code(204).send();
    return kind === "text" ? reply.type("text/plain").send("unchanged") : { text: "large ".repeat(200) };
  });
  app.post("/api/command", command);
  const headers = { "x-llm-chat-request-id": randomUUID(), "accept-encoding": kind === "json" ? "gzip" : "identity" };
  const options = { method: "POST" as const, url: "/api/command", headers, payload: {} };
  const first = await app.inject(options); const second = await app.inject(options);
  expect(second.statusCode).toBe(first.statusCode);
  expect(second.rawPayload).toEqual(first.rawPayload);
  expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
  expect(command).toHaveBeenCalledTimes(1);
});

it("preserves domain receipts and only expires old command records", async () => {
  const { app, store } = await fixture();
  store.acceptSubmission("old", "command:test:POST:/api/old", {}, () => ({ pending: true, createdAt: 1 }));
  store.acceptSubmission("domain", "messages:conversation", {}, () => ({ createdAt: 1, accepted: true }));
  store.acceptSubmission("recent", "command:test:POST:/api/recent", {}, () => ({ pending: true, createdAt: Date.now() }));
  const command = vi.fn(() => ({ ok: true })); app.post("/api/command", command);
  await app.inject({ method: "POST", url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID() }, payload: {} });
  expect(store.submissionResult("old", "command:test:POST:/api/old", {})).toBeNull();
  expect(store.submissionResult("domain", "messages:conversation", {})).not.toBeNull();
  expect(store.submissionResult("recent", "command:test:POST:/api/recent", {})).not.toBeNull();
});

it("fingerprints raw uploads without repeating file creation", async () => {
  const { app } = await fixture();
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  const command = vi.fn(() => ({ id: "one-file" })); app.post("/api/files", command);
  const options = { method: "POST" as const, url: "/api/files", headers: { "content-type": "application/octet-stream", "x-file-name": "file.txt", "x-file-type": "text/plain", "x-llm-chat-request-id": randomUUID() }, payload: Buffer.from("same bytes") };
  expect((await app.inject(options)).json()).toEqual({ id: "one-file" });
  expect((await app.inject(options)).json()).toEqual({ id: "one-file" });
  expect((await app.inject({ ...options, payload: Buffer.from("different") })).statusCode).toBe(409);
  expect(command).toHaveBeenCalledOnce();
});

it("retains an unknown reservation when a result cannot be persisted or replayed", async () => {
  const { app, store } = await fixture();
  const command = vi.fn((_request, reply) => reply.send(Readable.from(["result bytes"])));
  app.post("/api/stream", { config: { compress: false } }, command);
  const normal = vi.fn(() => ({ ok: true })); app.post("/api/command", normal);
  const options = { method: "POST" as const, url: "/api/stream", headers: { "x-llm-chat-request-id": randomUUID() }, payload: {} };
  expect((await app.inject(options)).body).toBe("result bytes");
  expect((await app.inject(options)).statusCode).toBe(409); expect(command).toHaveBeenCalledOnce();
  const failed = { ...options, url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID() } };
  vi.spyOn(store, "completeCommand").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  expect((await app.inject(failed)).statusCode).toBe(500);
  expect((await app.inject(failed)).statusCode).toBe(409); expect(normal).toHaveBeenCalledOnce();
});

it("leaves existing clients and domain idempotency handlers in control", async () => {
  const { app, store } = await fixture();
  const command = vi.fn(() => ({ ok: true }));
  for (const url of ["/api/command", "/api/auth/test", "/api/file-uploads/test"]) app.post(url, command);
  app.get("/api/command", command);
  for (const options of [
    { method: "POST" as const, url: "/api/command", headers: {}, payload: {} },
    { method: "GET" as const, url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID() } },
    { method: "POST" as const, url: "/api/auth/test", headers: { "x-llm-chat-request-id": randomUUID() }, payload: {} },
    { method: "POST" as const, url: "/api/file-uploads/test", headers: { "x-llm-chat-request-id": randomUUID() }, payload: {} },
    { method: "POST" as const, url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID() }, payload: { clientSubmissionId: randomUUID() } },
    { method: "POST" as const, url: "/api/command", headers: { "x-llm-chat-request-id": randomUUID(), "x-session": "none" }, payload: {} }
  ]) expect((await app.inject(options)).statusCode).toBe(200);
  expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM client_submissions").get()).toMatchObject({ count: 0 });
});
