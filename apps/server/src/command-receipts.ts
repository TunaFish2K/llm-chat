import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "./database";
import { createHash } from "node:crypto";

interface Result { pending?: boolean; status?: number; payload?: unknown; contentType?: string; createdAt: number }
interface Command { scope: string; id: string; serialized?: boolean; payload?: unknown; finish: (result: Result) => void }

/** Persist the reservation before running side effects; a restart never replays unknown work. */
export function registerCommandReceipts(app: FastifyInstance, store: Store): void {
  const commands = new WeakMap<FastifyRequest, Command>();
  const active = new Map<string, Promise<Result>>();
  let prunedAt = 0;
  app.addHook("preHandler", async (request, reply) => {
    if (!request.authIdentity || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    // Message submissions and chunk uploads already have domain-specific receipts.
    if (request.url.startsWith("/api/auth/") || request.url.startsWith("/api/file-uploads")
      || (request.body && typeof request.body === "object" && "clientSubmissionId" in request.body)) return;
    const raw = request.headers["x-llm-chat-request-id"];
    if (raw === undefined) return;
    const id = z.string().uuid().parse(raw);
    const scope = `command:${request.authIdentity.sessionId}:${request.method}:${request.url}`;
    const key = `${scope}:${id}`;
    const input = Buffer.isBuffer(request.body)
      ? { sha256: createHash("sha256").update(request.body).digest("hex"), name: request.headers["x-file-name"], type: request.headers["x-file-type"] }
      : request.body ?? null;
    const previous = store.submissionResult<Result>(id, scope, input);
    if (previous) {
      const result = previous.value.pending && active.has(key) ? await active.get(key)! : previous.value;
      if (result.pending) return reply.code(409).send({ error: { code: "request_unconfirmed", i18n: { key: "error.request_unconfirmed" }, message: "请求结果尚未确认，请先检查当前状态" } });
      if (result.contentType) reply.type(result.contentType);
      return reply.code(result.status!).send(result.status === 204 ? undefined : result.payload);
    }
    const now = Date.now();
    if (now - prunedAt > 60_000) { store.pruneCommands(now - 86_400_000); prunedAt = now; }
    store.acceptSubmission(id, scope, input, () => ({ pending: true, createdAt: now }));
    let finish!: (result: Result) => void;
    active.set(key, new Promise(resolve => { finish = resolve; }));
    commands.set(request, { scope, id, finish });
  });
  app.addHook("preSerialization", async (request, _reply, payload) => {
    const command = commands.get(request);
    if (command) { command.payload = payload; command.serialized = true; }
    return payload;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const command = commands.get(request);
    if (command) {
      const raw = !command.serialized && typeof payload === "string";
      const result: Result = command.serialized || raw || reply.statusCode === 204
        ? { status: reply.statusCode, payload: command.serialized ? command.payload : raw ? payload : null,
          ...(raw ? { contentType: String(reply.getHeader("content-type") ?? "text/plain") } : {}), createdAt: Date.now() }
        : { pending: true, createdAt: Date.now() };
      let saved = false;
      try { store.completeCommand(command.id, command.scope, result); saved = true; }
      finally {
        command.finish(saved ? result : { pending: true, createdAt: result.createdAt });
        active.delete(`${command.scope}:${command.id}`);
        commands.delete(request);
      }
    }
    return payload;
  });
  app.addHook("onClose", async () => {
    active.clear();
  });
}
