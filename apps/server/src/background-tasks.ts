import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BackgroundTaskDto, BackgroundTaskEventDto } from "@llm-chat/contracts";
import * as pty from "node-pty";
import type { AgentSnapshot, Store } from "./database";
import type { EventHub } from "./events";
import { terminalScreen } from "./terminal-screen";

const TERMINAL_STATES = new Set<BackgroundTaskDto["status"]>(["completed", "failed", "stopped", "timed_out", "interrupted"]);
const SEGMENT_BYTES = 1024 * 1024;
const MODEL_READ_LIMIT = 32 * 1024;

type Row = Record<string, unknown>;

interface RuntimeTask {
  pipe?: ChildProcessWithoutNullStreams;
  pty?: pty.IPty;
  writeChain: Promise<void>;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  termination?: Promise<void>;
  segmentStart: number;
  segmentSize: number;
  timeout?: NodeJS.Timeout;
  stoppingStatus?: "stopped" | "timed_out" | "interrupted";
  failure?: string;
}

export interface StartTaskInput {
  conversationId: string;
  generationId: string;
  snapshot: AgentSnapshot;
  command: string;
  mode: "pipe" | "pty";
  expectedDurationMs: number | null;
  hardTimeoutMs: number | null;
  workspacePath?: string | undefined;
}

export class TaskManager {
  private readonly runtime = new Map<string, RuntimeTask>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly store: Store, private readonly events: EventHub) {}

  create(input: StartTaskInput): BackgroundTaskDto {
    if (this.closed) throw new Error("Task manager is closing");
    const workspacePath = input.workspacePath ?? input.snapshot.workspacePath;
    if (!workspacePath) throw new Error("Conversation has no workspace");
    const id = randomUUID();
    const now = Date.now();
    this.store.sqlite.prepare(`
      INSERT INTO background_tasks (
        id, conversation_id, generation_id, agent_id, agent_name, agent_revision, command, mode,
        workspace_path, status, expected_duration_ms, hard_timeout_ms, log_limit_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, input.conversationId, input.generationId, input.snapshot.agentId, input.snapshot.name,
      input.snapshot.revision, input.command, input.mode, workspacePath,
      input.expectedDurationMs, input.hardTimeoutMs, input.snapshot.execution.taskLogLimitBytes, now);
    this.event(id, "state", null, { status: "queued" });
    const task = this.get(id)!;
    this.events.emit({ type: "task", taskId: id, task });
    void this.drain(input.snapshot.agentId);
    return task;
  }

  list(filters: { conversationId?: string; nonterminal?: boolean } = {}): BackgroundTaskDto[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.conversationId) { clauses.push("conversation_id = ?"); values.push(filters.conversationId); }
    if (filters.nonterminal) clauses.push("status IN ('queued','starting','running')");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.store.sqlite.prepare(`SELECT * FROM background_tasks ${where} ORDER BY created_at DESC`).all(...values) as Row[])
      .map(taskDto);
  }

  get(id: string): BackgroundTaskDto | undefined {
    const row = this.store.sqlite.prepare("SELECT * FROM background_tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? taskDto(row) : undefined;
  }

  eventsFor(taskId: string): BackgroundTaskEventDto[] {
    return (this.store.sqlite.prepare("SELECT * FROM background_task_events WHERE task_id = ? ORDER BY id").all(taskId) as Row[])
      .map((row) => ({
        id: Number(row.id), taskId: String(row.task_id), type: row.type as BackgroundTaskEventDto["type"],
        reason: textOrNull(row.reason), data: parseObject(row.data_json), createdAt: Number(row.created_at)
      }));
  }

  async read(id: string, cursor: number, limit = MODEL_READ_LIMIT): Promise<{ task: BackgroundTaskDto; cursor: number; earliestCursor: number; gap: boolean; raw: string; text: string; screen: string | null }> {
    const task = this.get(id);
    if (!task) throw new Error("Background task not found");
    const actualCursor = Math.max(cursor, task.earliestCursor);
    const cappedLimit = Math.max(1, Math.min(limit, MODEL_READ_LIMIT));
    const { bytes, cursor: nextCursor } = await this.readBytes(id, actualCursor, cappedLimit);
    const raw = new TextDecoder().decode(bytes);
    return {
      task,
      cursor: nextCursor,
      earliestCursor: task.earliestCursor,
      gap: cursor < task.earliestCursor,
      raw,
      text: raw.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, ""),
      screen: task.mode === "pty" ? await this.screen(id) : null
    };
  }

  async wait(id: string, cursor: number, timeoutMs: number, quietPeriodMs: number): Promise<Awaited<ReturnType<TaskManager["read"]>>> {
    const initial = this.get(id);
    if (!initial) throw new Error("Background task not found");
    if (initial.outputCursor > cursor || TERMINAL_STATES.has(initial.status)) return this.read(id, cursor);
    await new Promise<void>((finish) => {
      let quiet: NodeJS.Timeout | undefined;
      const done = () => { if (quiet) clearTimeout(quiet); clearTimeout(timeout); unsubscribe(); finish(); };
      const changed = () => {
        const current = this.get(id);
        if (!current || TERMINAL_STATES.has(current.status)) return done();
        if (current.outputCursor > cursor) {
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(done, Math.max(0, Math.min(quietPeriodMs, 30_000)));
        }
      };
      const unsubscribe = this.subscribe(id, changed);
      const timeout = setTimeout(done, Math.max(1, Math.min(timeoutMs, 120_000)));
    });
    return this.read(id, cursor);
  }

  write(id: string, data: string, reason: string): BackgroundTaskDto {
    if (!reason.trim()) throw new Error("reason is required");
    const task = this.get(id);
    const live = this.runtime.get(id);
    if (!task || task.status !== "running" || !live) throw new Error("Background task is not running");
    if (live.pty) live.pty.write(data);
    else live.pipe?.stdin.write(data);
    this.event(id, "write", reason, { bytes: Buffer.byteLength(data) });
    return this.get(id)!;
  }

  stop(id: string, reason: string): BackgroundTaskDto {
    if (!reason.trim()) throw new Error("reason is required");
    const task = this.get(id);
    if (!task) throw new Error("Background task not found");
    if (TERMINAL_STATES.has(task.status)) return task;
    this.event(id, "stop", reason, {});
    if (task.status === "queued") {
      this.finish(id, "stopped", null, null);
      return this.get(id)!;
    }
    const live = this.runtime.get(id);
    if (live) {
      live.stoppingStatus = "stopped";
      void this.terminate(live);
    }
    return this.get(id)!;
  }

  resize(id: string, columns: number, rows: number): void {
    this.runtime.get(id)?.pty?.resize(Math.max(20, Math.min(columns, 500)), Math.max(5, Math.min(rows, 200)));
  }

  hasNonterminalForAgent(agentId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM background_tasks WHERE agent_id = ? AND status IN ('queued','starting','running') LIMIT 1").get(agentId));
  }

  hasNonterminalForConversation(conversationId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM background_tasks WHERE conversation_id = ? AND status IN ('queued','starting','running') LIMIT 1").get(conversationId));
  }

  notifyAgentPolicyChanged(agentId: string): void { void this.drain(agentId); }

  runtimePrompt(conversationId: string): string {
    const tasks = this.list({ conversationId, nonterminal: true });
    if (!tasks.length) return "";
    return `<background_tasks>\n${tasks.map((task) => JSON.stringify({
      id: task.id, status: task.status, command: task.command, mode: task.mode,
      overdue: task.overdue, outputCursor: task.outputCursor, startedAt: task.startedAt
    })).join("\n")}\n</background_tasks>`;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const running = [...this.runtime.entries()];
    for (const [id, live] of running) {
      this.event(id, "warning", "服务关闭", {});
      live.stoppingStatus = "interrupted";
    }
    await Promise.all(running.map(([, live]) => this.terminate(live)));
    for (const task of this.list({ nonterminal: true })) {
      this.event(task.id, "warning", "服务关闭", {});
      this.finish(task.id, "interrupted", null, "服务关闭");
    }
  }

  private async drain(agentId: string | null): Promise<void> {
    if (this.closed) return;
    const key = agentId ?? "";
    const agent = agentId ? this.store.getAgent(agentId) : undefined;
    const limit = agent?.execution.maxBackgroundTasks ?? null;
    const running = Number((this.store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM background_tasks WHERE COALESCE(agent_id, '') = ? AND status IN ('starting','running')
    `).get(key) as Row).count);
    let slots = limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - running);
    const queued = this.store.sqlite.prepare(`
      SELECT id FROM background_tasks WHERE COALESCE(agent_id, '') = ? AND status = 'queued' ORDER BY created_at, id
    `).all(key) as Row[];
    for (const row of queued) {
      if (slots <= 0) break;
      slots -= 1;
      await this.launch(String(row.id));
    }
  }

  private async launch(id: string): Promise<void> {
    if (this.closed) return;
    const task = this.get(id);
    if (!task || task.status !== "queued") return;
    this.store.sqlite.prepare("UPDATE background_tasks SET status = 'starting' WHERE id = ? AND status = 'queued'").run(id);
    this.publish(id);
    await mkdir(this.logDir(id), { recursive: true, mode: 0o700 });
    if (this.closed) {
      this.finish(id, "interrupted", null, "服务关闭");
      return;
    }
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolvePromise) => { resolveExit = resolvePromise; });
    const live: RuntimeTask = {
      writeChain: Promise.resolve(), exitPromise, resolveExit, segmentStart: 0, segmentSize: 0
    };
    this.runtime.set(id, live);
    const shell = process.env.SHELL || "/bin/sh";
    try {
      if (task.mode === "pty") {
        const terminal = pty.spawn(shell, ["-lc", task.command], {
          name: "xterm-256color", cols: 120, rows: 40, cwd: task.workspacePath,
          env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>
        });
        live.pty = terminal;
        terminal.onData((data) => this.append(id, Buffer.from(data)));
        terminal.onExit(({ exitCode }) => void this.onExit(id, exitCode));
        this.markRunning(id, terminal.pid);
      } else {
        const child = spawn(shell, ["-lc", task.command], {
          cwd: task.workspacePath, env: process.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]
        });
        live.pipe = child;
        child.stdout.on("data", (data: Buffer) => this.append(id, data));
        child.stderr.on("data", (data: Buffer) => this.append(id, data));
        child.on("error", (error) => this.finish(id, "failed", null, error.message));
        child.on("close", (code) => void this.onExit(id, code));
        this.markRunning(id, child.pid ?? null);
      }
      const refreshed = this.get(id)!;
      if (refreshed.hardTimeoutMs !== null) {
        live.timeout = setTimeout(() => {
          live.stoppingStatus = "timed_out";
          this.event(id, "warning", "达到硬超时", { hardTimeoutMs: refreshed.hardTimeoutMs });
          void this.terminate(live);
        }, refreshed.hardTimeoutMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (live.pipe || live.pty) {
        live.failure = message;
        void this.terminate(live);
      } else {
        this.finish(id, "failed", null, message);
      }
    }
  }

  private markRunning(id: string, pid: number | null): void {
    const now = Date.now();
    this.store.sqlite.prepare(`
      UPDATE background_tasks SET status = 'running', pid = ?, process_group_id = ?, process_start_identity = ?, started_at = ? WHERE id = ?
    `).run(pid, pid, pid ? processStartIdentity(pid) : null, now, id);
    this.event(id, "state", null, { status: "running", pid });
    this.publish(id);
  }

  private append(id: string, data: Buffer): void {
    const live = this.runtime.get(id);
    if (!live || !data.length) return;
    live.writeChain = live.writeChain.then(async () => {
      let offset = 0;
      while (offset < data.length) {
        if (live.segmentSize >= SEGMENT_BYTES) {
          live.segmentStart += live.segmentSize;
          live.segmentSize = 0;
        }
        const part = data.subarray(offset, offset + Math.min(data.length - offset, SEGMENT_BYTES - live.segmentSize));
        await appendFile(resolve(this.logDir(id), `${String(live.segmentStart).padStart(16, "0")}.log`), part, { mode: 0o600 });
        live.segmentSize += part.length;
        offset += part.length;
      }
      const cursor = live.segmentStart + live.segmentSize;
      this.store.sqlite.prepare("UPDATE background_tasks SET output_cursor = ? WHERE id = ?").run(cursor, id);
      await this.rotate(id);
      this.event(id, "output", null, { cursor });
      this.events.emit({ type: "task-output", taskId: id, cursor });
      this.notify(id);
    }).catch((error) => {
      live.failure = error instanceof Error ? error.message : String(error);
      void this.terminate(live);
    });
  }

  private async rotate(id: string): Promise<void> {
    const row = this.store.sqlite.prepare("SELECT log_limit_bytes, output_cursor FROM background_tasks WHERE id = ?").get(id) as Row;
    const limit = nullableNumber(row.log_limit_bytes);
    if (limit === null) return;
    const files = await this.segmentFiles(id);
    let retained = Number(row.output_cursor) - Number((this.get(id)?.earliestCursor ?? 0));
    let earliest = this.get(id)?.earliestCursor ?? 0;
    for (const file of files.slice(0, -1)) {
      if (retained <= limit) break;
      const info = await stat(resolve(this.logDir(id), file.name));
      await rm(resolve(this.logDir(id), file.name), { force: true });
      retained -= info.size;
      earliest = file.start + info.size;
    }
    this.store.sqlite.prepare("UPDATE background_tasks SET earliest_cursor = ? WHERE id = ?").run(earliest, id);
  }

  private async onExit(id: string, exitCode: number | null): Promise<void> {
    const live = this.runtime.get(id);
    if (!live) return;
    await live.writeChain;
    const status = live.stoppingStatus ?? (live.failure || exitCode !== 0 ? "failed" : "completed");
    const error = status === "failed"
      ? live.failure ?? `进程退出码 ${exitCode ?? "unknown"}`
      : status === "interrupted" ? "服务关闭" : null;
    this.finish(id, status, exitCode, error);
  }

  private finish(id: string, status: BackgroundTaskDto["status"], exitCode: number | null, error: string | null): void {
    const live = this.runtime.get(id);
    if (live?.timeout) clearTimeout(live.timeout);
    this.runtime.delete(id);
    this.store.sqlite.prepare(`
      UPDATE background_tasks SET status = ?, exit_code = ?, error = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('completed','failed','stopped','timed_out','interrupted')
    `).run(status, exitCode, error, Date.now(), id);
    this.event(id, "state", null, { status, exitCode, error });
    this.publish(id);
    this.notify(id);
    live?.resolveExit();
    const task = this.get(id);
    if (task) void this.drain(task.agentId);
  }

  private terminate(live: RuntimeTask): Promise<void> {
    live.termination ??= this.terminateProcess(live);
    return live.termination;
  }

  private async terminateProcess(live: RuntimeTask): Promise<void> {
    this.signal(live, "SIGTERM");
    if (!await exitsWithin(live.exitPromise, 2_000)) this.signal(live, "SIGKILL");
    await live.exitPromise;
  }

  private signal(live: RuntimeTask, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = live.pty?.pid ?? live.pipe?.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {}
    }
    try {
      if (live.pty) live.pty.kill(signal);
      else live.pipe?.kill(signal);
    } catch {}
  }

  private async readBytes(id: string, cursor: number, limit: number): Promise<{ bytes: Uint8Array; cursor: number }> {
    const chunks: Buffer[] = [];
    let remaining = limit;
    let next = cursor;
    for (const file of await this.segmentFiles(id)) {
      const content = await readFile(resolve(this.logDir(id), file.name));
      const end = file.start + content.length;
      if (end <= next) continue;
      const from = Math.max(0, next - file.start);
      const part = content.subarray(from, from + remaining);
      chunks.push(part);
      remaining -= part.length;
      next += part.length;
      if (!remaining) break;
    }
    return { bytes: Buffer.concat(chunks), cursor: next };
  }

  private async screen(id: string): Promise<string> {
    const task = this.get(id)!;
    const { bytes } = await this.readBytes(id, task.earliestCursor, Math.min(task.outputCursor - task.earliestCursor, 4 * 1024 * 1024));
    return terminalScreen(new TextDecoder().decode(bytes));
  }

  private async segmentFiles(id: string): Promise<Array<{ name: string; start: number }>> {
    try {
      return (await readdir(this.logDir(id))).filter((name) => /^\d+\.log$/.test(name))
        .map((name) => ({ name, start: Number(name.slice(0, -4)) })).sort((a, b) => a.start - b.start);
    } catch { return []; }
  }

  private event(taskId: string, type: BackgroundTaskEventDto["type"], reason: string | null, data: Record<string, unknown>): void {
    this.store.sqlite.prepare("INSERT INTO background_task_events (task_id, type, reason, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, type, reason, JSON.stringify(data), Date.now());
  }

  private publish(id: string): void {
    const task = this.get(id);
    if (task) this.events.emit({ type: "task", taskId: id, task });
  }

  private subscribe(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  private notify(id: string): void { for (const listener of this.listeners.get(id) ?? []) listener(); }
  private logDir(id: string): string { return resolve(this.store.dataDir, "tasks", id); }
}

async function exitsWithin(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<false>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function taskDto(row: Row): BackgroundTaskDto {
  const startedAt = nullableNumber(row.started_at);
  const expected = nullableNumber(row.expected_duration_ms);
  const status = row.status as BackgroundTaskDto["status"];
  return {
    id: String(row.id), conversationId: String(row.conversation_id), generationId: String(row.generation_id),
    agentId: textOrNull(row.agent_id), agentName: String(row.agent_name), agentRevision: Number(row.agent_revision),
    command: String(row.command), mode: row.mode as "pipe" | "pty", workspacePath: String(row.workspace_path), status,
    expectedDurationMs: expected, hardTimeoutMs: nullableNumber(row.hard_timeout_ms),
    overdue: expected !== null && startedAt !== null && !TERMINAL_STATES.has(status) && Date.now() > startedAt + expected,
    exitCode: nullableNumber(row.exit_code), error: textOrNull(row.error), outputCursor: Number(row.output_cursor),
    earliestCursor: Number(row.earliest_cursor), createdAt: Number(row.created_at), startedAt,
    completedAt: nullableNumber(row.completed_at)
  };
}

function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function textOrNull(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function parseObject(value: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

export function processStartIdentity(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch { return null; }
}
