import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CodexCreateSessionInput,
  CodexEventDto,
  CodexProfile,
  CodexResponseInput,
  CodexRuntimeDto,
  CodexSessionDetailDto,
  CodexSessionDto,
  CodexSessionStatus,
  CodexThreadDto,
  CodexTurnInput
} from "@llm-chat/contracts";
import type { Store } from "./database";
import { StoreError } from "./errors";
import type { EventHub } from "./events";

const execFileAsync = promisify(execFile);
type Row = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingServerRequest {
  rpcId: RpcId;
  sessionId: string;
  method: string;
}

export interface CodexManagerOptions {
  binary?: string;
  socketPath?: string;
  profile?: CodexProfile;
}

class CodexRpcClient {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly lines: Interface;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    onNotification: (message: RpcMessage) => void,
    onRequest: (message: RpcMessage) => void
  ) {
    this.lines = createInterface({ input: process.stdout });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id !== undefined && (Object.prototype.hasOwnProperty.call(message, "result") || message.error !== undefined)) {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server 请求失败"));
        else pending.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) onRequest(message);
      else if (message.method) onNotification(message);
    });
    process.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    process.on("close", () => {
      const error = new Error("Codex app-server 已断开");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "llm-chat", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized");
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.process.stdin.writable) return Promise.reject(new Error("Codex app-server 不可用"));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      this.pending.set(String(id), { resolve: resolvePromise, reject });
      this.write(message, (error) => {
        if (!error) return;
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }

  respond(id: RpcId, result: unknown): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("Codex app-server 不可用");
    this.write({ jsonrpc: "2.0", id, result });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.process.stdin.writable) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.process.kill();
  }

  private write(message: Record<string, unknown>, callback?: (error?: Error | null) => void): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }
}

export class CodexManager {
  private client: CodexRpcClient | null = null;
  private connecting: Promise<CodexRpcClient> | null = null;
  private closed = false;
  private readonly pendingRequests = new Map<string, PendingServerRequest>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private runtime: CodexRuntimeDto;

  constructor(
    private readonly store: Store,
    private readonly events: EventHub,
    options: CodexManagerOptions = {}
  ) {
    const binary = options.binary ?? process.env.LLM_CHAT_CODEX_BIN ?? "codex";
    const socketPath = options.socketPath
      ?? process.env.LLM_CHAT_CODEX_SOCKET
      ?? resolve(homedir(), ".codex", "app-server-control", "app-server-control.sock");
    const profile = options.profile ?? (process.env.LLM_CHAT_CODEX_PROFILE === "trusted-local-yolo"
      ? "trusted-local-yolo"
      : "server-workspace");
    this.runtime = {
      available: false, connected: false, binary, version: null, socketPath, profile, error: null, checkedAt: Date.now()
    };
  }

  initialize(): void {
    if (!this.listSessions().length) return;
    void this.reconnectPersisted();
  }

  async status(): Promise<CodexRuntimeDto> {
    try {
      await this.ensureClient();
    } catch (error) {
      this.runtime = { ...this.runtime, available: false, connected: false, error: errorMessage(error), checkedAt: Date.now() };
    }
    return { ...this.runtime };
  }

  async listThreads(cwd?: string): Promise<CodexThreadDto[]> {
    const client = await this.ensureClient();
    const result = asObject(await client.request("thread/list", { cwd: cwd ?? null, limit: 100 }));
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((value) => threadDto(asObject(value))).filter((thread) => !cwd || thread.cwd === cwd);
  }

  listSessions(conversationId?: string): CodexSessionDto[] {
    const rows = (this.store.sqlite.prepare(
      `SELECT s.*, COALESCE((SELECT MAX(id) FROM codex_events WHERE session_id = s.id), 0) AS last_event_id
       FROM codex_sessions s ${conversationId ? "WHERE s.conversation_id = ?" : ""} ORDER BY s.updated_at DESC`
    ).all(...(conversationId ? [conversationId] : [])) as Row[]);
    return rows.map(sessionDto);
  }

  getSession(id: string): CodexSessionDto | undefined {
    const row = this.store.sqlite.prepare(
      "SELECT s.*, COALESCE((SELECT MAX(id) FROM codex_events WHERE session_id = s.id), 0) AS last_event_id FROM codex_sessions s WHERE s.id = ?"
    ).get(id) as Row | undefined;
    return row ? sessionDto(row) : undefined;
  }

  detail(id: string, after = 0): CodexSessionDetailDto {
    const session = this.requireSession(id);
    const rows = this.store.sqlite.prepare(
      "SELECT * FROM codex_events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 500"
    ).all(id, Math.max(0, after)) as Row[];
    return { session, events: rows.map(eventDto) };
  }

  async create(input: CodexCreateSessionInput): Promise<CodexSessionDto> {
    const conversation = this.store.getConversation(input.conversationId);
    if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
    if (!conversation.workspacePath) throw new StoreError("conversation_workspace_required", "会话没有工作目录");
    const existing = this.listSessions(input.conversationId).find((session) => session.status !== "stopped");
    if (existing && !input.threadId) return existing;
    const client = await this.ensureClient();
    const profile = input.profile === "trusted-local-yolo" && this.runtime.profile !== "trusted-local-yolo"
      ? "server-workspace"
      : input.profile;
    const policy = codexPolicy(profile, conversation.workspacePath);
    const result = asObject(await client.request(input.threadId ? "thread/resume" : "thread/start", input.threadId
      ? { threadId: input.threadId, cwd: conversation.workspacePath, ...policy }
      : { cwd: conversation.workspacePath, ...policy }));
    const thread = asObject(result.thread);
    const threadId = stringValue(thread.id);
    if (!threadId) throw new Error("Codex 未返回 thread ID");
    const threadCwd = stringValue(thread.cwd) ?? conversation.workspacePath;
    if (threadCwd !== conversation.workspacePath) throw new Error("Codex thread 工作目录与会话不一致");
    const now = Date.now();
    const id = cryptoRandomId();
    this.store.sqlite.prepare(`
      INSERT INTO codex_sessions (id, conversation_id, thread_id, cwd, preview, status, profile, model, managed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, 1, ?, ?)
    `).run(id, input.conversationId, threadId, threadCwd, stringValue(thread.preview) ?? "", profile,
      stringValue(thread.model) ?? stringValue(result.model) ?? "", now, now);
    this.appendEvent(id, "status", input.threadId ? "thread/resume" : "thread/start", { status: "idle", threadId });
    return this.getSession(id)!;
  }

  async send(id: string, input: CodexTurnInput): Promise<CodexSessionDto> {
    const session = this.requireSession(id);
    const client = await this.ensureClient();
    const inputItem = { type: "text", text: input.text, text_elements: [] };
    const result = session.currentTurnId
      ? await client.request("turn/steer", { threadId: session.threadId, expectedTurnId: session.currentTurnId, input: [inputItem] })
      : await client.request("turn/start", { threadId: session.threadId, input: [inputItem] });
    const turn = asObject(asObject(result).turn);
    const turnId = stringValue(turn.id);
    this.updateSession(id, { status: "running", currentTurnId: turnId ?? null, error: null });
    this.appendEvent(id, "turn", session.currentTurnId ? "turn/steer" : "turn/start", { turnId, text: input.text });
    return this.getSession(id)!;
  }

  async wait(id: string, after: number, timeoutMs: number, signal?: AbortSignal): Promise<CodexSessionDetailDto> {
    const initial = this.detail(id, after);
    if (initial.events.length || isFinalStatus(initial.session.status)) return initial;
    const sessionWaiters = this.waiters.get(id) ?? new Set<() => void>();
    this.waiters.set(id, sessionWaiters);
    await new Promise<void>((resolvePromise, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        sessionWaiters.delete(done);
        if (signal) signal.removeEventListener("abort", abort);
        resolvePromise();
      };
      const abort = () => {
        if (timer) clearTimeout(timer);
        sessionWaiters.delete(done);
        reject(signal?.reason ?? new Error("Codex wait cancelled"));
      };
      sessionWaiters.add(done);
      timer = setTimeout(done, Math.max(100, Math.min(timeoutMs, 120_000)));
      if (signal) signal.addEventListener("abort", abort, { once: true });
    });
    return this.detail(id, after);
  }

  async respond(id: string, input: CodexResponseInput): Promise<CodexSessionDto> {
    const session = this.requireSession(id);
    const pending = [...this.pendingRequests.values()].find((request) => request.sessionId === id && String(request.rpcId) === input.requestId);
    if (!pending) throw new StoreError("codex_request_not_pending", "Codex 请求已处理或已失效");
    const client = await this.ensureClient();
    client.respond(pending.rpcId, input.response);
    this.pendingRequests.delete(input.requestId);
    this.updateSession(id, { status: "running", error: null });
    this.appendEvent(id, "status", "client/response", { requestId: input.requestId });
    return this.getSession(id)!;
  }

  async interrupt(id: string): Promise<CodexSessionDto> {
    const session = this.requireSession(id);
    if (session.currentTurnId) {
      const client = await this.ensureClient();
      await client.request("turn/interrupt", { threadId: session.threadId, turnId: session.currentTurnId });
    }
    this.updateSession(id, { status: "stopped", currentTurnId: null });
    this.appendEvent(id, "status", "turn/interrupt", { status: "stopped" });
    return this.getSession(id)!;
  }

  detach(id: string): void {
    this.requireSession(id);
    this.store.sqlite.prepare("DELETE FROM codex_sessions WHERE id = ?").run(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client?.close();
    this.client = null;
  }

  private async reconnectPersisted(): Promise<void> {
    try {
      const client = await this.ensureClient();
      for (const session of this.listSessions()) {
        try {
          const result = asObject(await client.request("thread/resume", {
            threadId: session.threadId,
            cwd: session.cwd,
            ...codexPolicy(session.profile, session.cwd)
          }));
          const thread = asObject(result.thread);
          this.updateSession(session.id, {
            status: "idle", currentTurnId: null, preview: stringValue(thread.preview) ?? session.preview, error: null
          });
        } catch (error) {
          this.updateSession(session.id, { status: "detached", error: errorMessage(error) });
        }
      }
    } catch {
      // The runtime remains lazy when Codex is not installed or authenticated.
    }
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    if (this.client) return this.client;
    if (this.closed) throw new Error("Codex manager 已关闭");
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<CodexRpcClient> {
    const versionResult = await execFileAsync(this.runtime.binary, ["--version"], { timeout: 15_000 });
    const version = String(versionResult.stdout).trim();
    let useProxy = existsSync(this.runtime.socketPath);
    try {
      await execFileAsync(this.runtime.binary, ["app-server", "daemon", "start"], { timeout: 30_000 });
      useProxy = true;
    } catch {
      // npm-installed Codex does not ship the standalone daemon manager.
      // Its stdio transport provides the same app-server protocol without a socket.
    }
    const startClient = (proxy: boolean): CodexRpcClient => {
      const process = spawn(this.runtime.binary, proxy
        ? ["app-server", "proxy", "--sock", this.runtime.socketPath]
        : ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new CodexRpcClient(
        process,
        (message) => this.handleNotification(message),
        (message) => this.handleServerRequest(message)
      );
      process.stderr.on("data", () => undefined);
      return client;
    };
    let client = startClient(useProxy);
    try {
      await withTimeout(client.initialize(), 10_000);
    } catch (error) {
      client.close();
      if (!useProxy) throw error;
      useProxy = false;
      client = startClient(false);
      try {
        await withTimeout(client.initialize(), 10_000);
      } catch (fallbackError) {
        client.close();
        throw fallbackError;
      }
    }
    this.client = client;
    this.runtime = { ...this.runtime, available: true, connected: true, version, error: null, checkedAt: Date.now() };
    process.once("close", () => {
      if (this.client === client) {
        this.client = null;
        this.runtime = { ...this.runtime, connected: false, error: "Codex app-server 已断开", checkedAt: Date.now() };
        for (const session of this.listSessions()) {
          this.updateSession(session.id, { status: "detached", error: "Codex app-server 已断开" });
        }
      }
    });
    return client;
  }

  private handleNotification(message: RpcMessage): void {
    const method = message.method ?? "notification";
    const params = asObject(message.params);
    const threadId = stringValue(params.threadId);
    const session = threadId ? this.sessionByThread(threadId) : undefined;
    if (!session) return;
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.pendingRequests.delete(String(requestId));
      }
      this.updateSession(session.id, { status: "running", error: null });
    } else if (method === "turn/started") {
      const turn = asObject(params.turn);
      this.updateSession(session.id, { status: "running", currentTurnId: stringValue(turn.id) ?? null });
    } else if (method === "turn/completed") {
      this.updateSession(session.id, { status: "idle", currentTurnId: null, error: null });
    } else if (method === "thread/status/changed") {
      const status = stringValue(asObject(params.status).type) ?? stringValue(params.status) ?? "idle";
      this.updateSession(session.id, { status: normalizeStatus(status) });
    }
    this.appendEvent(session.id, eventKind(method), method, params);
  }

  private handleServerRequest(message: RpcMessage): void {
    const method = message.method ?? "request";
    const params = asObject(message.params);
    const threadId = stringValue(params.threadId);
    const session = threadId ? this.sessionByThread(threadId) : undefined;
    if (!session || message.id === undefined) {
      if (message.id !== undefined) this.client?.respond(message.id, {});
      return;
    }
    const requestId = String(message.id);
    this.pendingRequests.set(requestId, { rpcId: message.id, sessionId: session.id, method });
    this.updateSession(session.id, { status: "waiting-approval" });
    this.appendEvent(session.id, method.includes("UserInput") ? "input" : "approval", method, {
      requestId, method, params
    });
  }

  private appendEvent(sessionId: string, kind: CodexEventDto["kind"], method: string, payload: JsonObject): void {
    const createdAt = Date.now();
    const result = this.store.sqlite.prepare(
      "INSERT INTO codex_events (session_id, kind, method, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, kind, method, JSON.stringify(payload), createdAt);
    this.store.sqlite.prepare(`
      DELETE FROM codex_events WHERE session_id = ? AND id NOT IN
        (SELECT id FROM codex_events WHERE session_id = ? ORDER BY id DESC LIMIT 500)
    `).run(sessionId, sessionId);
    const session = this.getSession(sessionId);
    if (!session) return;
    const event = {
      id: Number(result.lastInsertRowid), sessionId, kind, method, payload, createdAt
    } satisfies CodexEventDto;
    this.events.emit({ type: "codex", sessionId, conversationId: session.conversationId, session, event });
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter();
  }

  private updateSession(id: string, patch: Partial<Pick<CodexSessionDto, "status" | "currentTurnId" | "preview" | "error">>): void {
    const current = this.getSession(id);
    if (!current) return;
    this.store.sqlite.prepare(`
      UPDATE codex_sessions SET status = ?, current_turn_id = ?, preview = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(patch.status ?? current.status, patch.currentTurnId === undefined ? current.currentTurnId : patch.currentTurnId,
      patch.preview ?? current.preview, patch.error === undefined ? current.error : patch.error, Date.now(), id);
  }

  private requireSession(id: string): CodexSessionDto {
    const session = this.getSession(id);
    if (!session) throw new StoreError("codex_session_not_found", "Codex 会话不存在");
    return session;
  }

  private sessionByThread(threadId: string): CodexSessionDto | undefined {
    const row = this.store.sqlite.prepare(
      "SELECT s.*, COALESCE((SELECT MAX(id) FROM codex_events WHERE session_id = s.id), 0) AS last_event_id FROM codex_sessions s WHERE s.thread_id = ?"
    ).get(threadId) as Row | undefined;
    return row ? sessionDto(row) : undefined;
  }
}

function codexPolicy(profile: CodexProfile, cwd: string): JsonObject {
  return profile === "trusted-local-yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write", cwd };
}

function eventKind(method: string): CodexEventDto["kind"] {
  if (method.includes("requestApproval")) return "approval";
  if (method.includes("requestUserInput")) return "input";
  if (method.includes("agentMessage") || method.includes("plan")) return "message";
  if (method.includes("commandExecution") || method.includes("command/")) return "command";
  if (method.includes("fileChange")) return "file-change";
  if (method.startsWith("turn/")) return "turn";
  if (method.startsWith("thread/")) return "status";
  return "item";
}

function normalizeStatus(status: string): CodexSessionStatus {
  if (status.includes("wait") || status.includes("approval")) return "waiting-approval";
  if (status.includes("run") || status.includes("active")) return "running";
  if (status.includes("error")) return "error";
  if (status.includes("notloaded")) return "detached";
  if (status.includes("stop") || status.includes("complete") || status.includes("idle")) return "idle";
  return "idle";
}

function sessionDto(row: Row): CodexSessionDto {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), threadId: String(row.thread_id), cwd: String(row.cwd),
    preview: String(row.preview ?? ""), status: row.status as CodexSessionStatus, profile: row.profile as CodexProfile,
    model: row.model === null ? null : String(row.model), currentTurnId: row.current_turn_id === null ? null : String(row.current_turn_id),
    lastEventId: Number((row.last_event_id ?? 0)), managed: Boolean(row.managed), error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

function eventDto(row: Row): CodexEventDto {
  return {
    id: Number(row.id), sessionId: String(row.session_id), kind: row.kind as CodexEventDto["kind"], method: String(row.method),
    payload: asObject(parseJson(row.payload_json)), createdAt: Number(row.created_at)
  };
}

function threadDto(value: JsonObject): CodexThreadDto {
  return {
    id: String(value.id ?? ""), preview: String(value.preview ?? ""), cwd: String(value.cwd ?? ""), status: String(value.status ?? ""),
    model: value.model === null || value.model === undefined ? null : String(value.model), updatedAt: Number(value.updatedAt ?? 0) * 1_000,
    source: typeof value.source === "object" ? String(asObject(value.source).kind ?? "") : String(value.source ?? ""),
    name: value.name === null || value.name === undefined ? null : String(value.name)
  };
}

function parseJson(value: unknown): unknown {
  try { return JSON.parse(String(value ?? "{}")); } catch { return {}; }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function isFinalStatus(status: CodexSessionStatus): boolean {
  return status === "stopped" || status === "error" || status === "detached";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex app-server 握手超时")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
