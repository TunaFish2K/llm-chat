import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ContainerEngine, ConversationEnvironmentDto, ExecutionEnvironment } from "@llm-chat/contracts";
import type { Store } from "./database";
import { LocalContainerEngine, type EngineAdapter, type EngineCommand } from "./container-engine";
import { executeProcess } from "./shell";

type ContainerConfig = Extract<ExecutionEnvironment, { type: "container" }>;
type EnvironmentRow = { id: string; conversation_id: string; engine: ContainerEngine; image: string; workspace_path: string;
  container_name: string; status: ConversationEnvironmentDto["status"]; error: string | null; last_used_at: number; idle_timeout_minutes: number; };
export interface ContainerExecution extends EngineCommand {
  environmentId: string;
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  release(): void;
}
const RUNTIME = fileURLToPath(new URL("../../../containers/runtime", import.meta.url));
const OWNER_LABEL = "fish.2kb.llm-chat.owner";
const canonicalPath = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const bindMount = (source: string, destination: string, readonly = false) =>
  [`type=bind`, `src=${source}`, `dst=${destination}`, ...(readonly ? ["readonly"] : [])]
    .map(field => /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(",");

export class ContainerEnvironments {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, number>();
  private readonly engines: Record<ContainerEngine, EngineAdapter>;
  private timer: NodeJS.Timeout | undefined;
  private closing = false;
  private readonly owner: string;
  constructor(private readonly store: Store, engines?: Record<ContainerEngine, EngineAdapter>) {
    this.engines = engines ?? { docker: new LocalContainerEngine("docker"), podman: new LocalContainerEngine("podman") };
    this.owner = createHash("sha256").update(resolve(store.dataDir)).digest("hex").slice(0, 24);
  }
  async initialize(): Promise<void> {
    for (const row of this.rows()) {
      try {
        if (await this.inspect(row)) await this.engines[row.engine].run(["stop", "--time", "3", row.container_name]);
        this.state(row.id, "stopped");
      } catch (error) { this.failed(row.id, error); }
    }
    await this.cleanupDeleted();
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 30_000);
    this.timer.unref();
  }
  async catalog() { return Promise.all(Object.values(this.engines).map(engine => engine.probe())); }
  workspace(conversationId: string, selected: string | null): string {
    return selected ?? resolve(this.store.dataDir, "container-workspaces", conversationId);
  }
  list(conversationId: string): ConversationEnvironmentDto[] {
    return this.rows(conversationId).map(row => ({ id: row.id, conversationId: row.conversation_id, engine: row.engine, image: row.image,
      workspacePath: row.workspace_path, status: row.status, error: row.error, lastUsedAt: row.last_used_at, idleTimeoutMinutes: row.idle_timeout_minutes }));
  }
  private rows(conversationId?: string): EnvironmentRow[] {
    return this.store.sqlite.prepare(`SELECT * FROM conversation_environments${conversationId ? " WHERE conversation_id = ?" : ""} ORDER BY created_at`)
      .all(...(conversationId ? [conversationId] : [])) as unknown as EnvironmentRow[];
  }
  private async locked<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(conversationId, next);
    try { return await next; } finally { if (this.locks.get(conversationId) === next) this.locks.delete(conversationId); }
  }
  private busy(row: EnvironmentRow): boolean {
    if (this.leases.get(row.id)) return true;
    return this.store.sqlite.prepare(`SELECT environment_id, environment_config_json FROM background_tasks
      WHERE conversation_id = ? AND status IN ('queued','starting','running')`).all(row.conversation_id).some(task => {
      if (task.environment_id === row.id) return true;
      if (!task.environment_config_json) return false;
      const saved = JSON.parse(String(task.environment_config_json));
      return saved.config.engine === row.engine && saved.config.image === row.image
        && canonicalPath(this.workspace(row.conversation_id, saved.selected)) === row.workspace_path;
    });
  }
  assertCanUse(conversationId: string, config: ExecutionEnvironment, selected: string | null): void {
    const matches = (engine: string, image: string, workspace: string) => config.type === "container"
      && engine === config.engine && image === config.image && canonicalPath(workspace) === canonicalPath(this.workspace(conversationId, selected));
    for (const row of this.rows(conversationId)) {
      if (this.busy(row) && !matches(row.engine, row.image, row.workspace_path)) {
        throw new Error("Another environment has active tools or background tasks; stop or finish them before switching");
      }
    }
    const pending = this.store.sqlite.prepare(`SELECT environment_config_json FROM background_tasks
      WHERE conversation_id = ? AND status IN ('queued','starting','running') AND environment_config_json IS NOT NULL`).all(conversationId);
    for (const task of pending) {
      const saved = JSON.parse(String(task.environment_config_json));
      if (!matches(saved.config.engine, saved.config.image, this.workspace(conversationId, saved.selected))) {
        throw new Error("Another environment has active tools or background tasks; stop or finish them before switching");
      }
    }
  }
  private state(id: string, status: EnvironmentRow["status"], error: string | null = null): void {
    this.store.sqlite.prepare("UPDATE conversation_environments SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }
  private failed(id: string, error: unknown): void { this.state(id, "error", error instanceof Error ? error.message : String(error)); }
  private async inspect(row: EnvironmentRow): Promise<{ State: { Running: boolean }; Config: { Labels?: Record<string, string> } } | null> {
    const engine = this.engines[row.engine];
    const ids = await engine.run(["ps", "-a", "--filter", `name=^${row.container_name}$`, "--format", "{{.ID}}"]);
    if (!ids) return null;
    const info = JSON.parse(await engine.run(["inspect", row.container_name]))[0];
    if (info.Config?.Labels?.[OWNER_LABEL] !== this.owner) throw new Error("Container ownership does not match this service");
    return info;
  }
  async enterHost(conversationId: string): Promise<void> {
    await this.locked(conversationId, async () => {
      this.assertCanUse(conversationId, { type: "host" }, null);
      for (const row of this.rows(conversationId)) {
        if (this.busy(row)) throw new Error("A container environment has active tools or background tasks; stop or finish them before using the host");
        if (row.status === "running" || row.status === "error") await this.stopRow(row);
      }
    });
  }
  async register(conversationId: string, config: ContainerConfig, selected: string | null): Promise<string> {
    if (this.closing || !this.store.getConversation(conversationId)) throw new Error("Conversation environment is unavailable");
    const workspace = this.workspace(conversationId, selected);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const canonical = await realpath(workspace);
    if (this.closing || !this.store.getConversation(conversationId)) throw new Error("Conversation environment is unavailable");
    const old = this.rows(conversationId).find(row => row.engine === config.engine && row.image === config.image && row.workspace_path === canonical);
    if (old) {
      this.store.sqlite.prepare("UPDATE conversation_environments SET idle_timeout_minutes = ? WHERE id = ?").run(config.idleTimeoutMinutes, old.id);
      return old.id;
    }
    const id = randomUUID();
    this.store.sqlite.prepare(`INSERT OR IGNORE INTO conversation_environments
      (id,conversation_id,engine,image,workspace_path,container_name,status,last_used_at,idle_timeout_minutes,created_at)
      VALUES (?,?,?,?,?,?,'created',?,?,?)`).run(id, conversationId, config.engine, config.image, canonical, `llm-chat-${this.owner}-${id}`, Date.now(), config.idleTimeoutMinutes, Date.now());
    return this.rows(conversationId).find(row => row.engine === config.engine && row.image === config.image && row.workspace_path === canonical)!.id;
  }
  async prepare(conversationId: string, config: ContainerConfig, selected: string | null, command: string, cwd: string, tty = false, signal?: AbortSignal): Promise<ContainerExecution> {
    const id = await this.register(conversationId, config, selected);
    return this.locked(conversationId, async () => {
      if (this.closing) throw new Error("Container environments are closing");
      signal?.throwIfAborted();
      if (!this.store.getConversation(conversationId)) throw new Error("Conversation no longer exists");
      this.assertCanUse(conversationId, config, selected);
      const row = this.rows(conversationId).find(entry => entry.id === id)!;
      try {
        for (const other of this.rows(conversationId).filter(entry => entry.id !== id)) {
          if (this.busy(other)) throw new Error("Another environment has active tools or background tasks; stop or finish them before switching");
          if (other.status === "running" || other.status === "error") await this.stopRow(other);
        }
        const engine = this.engines[row.engine];
        const availability = await engine.probe();
        if (!availability.available) throw new Error(availability.error!);
        let info = await this.inspect(row);
        const uid = process.getuid?.() ?? 1000;
        const gid = process.getgid?.() ?? 1000;
        if (!info) {
          const attachments = resolve(this.store.dataDir, "attachment-workspaces", conversationId);
          await mkdir(attachments, { recursive: true, mode: 0o700 });
          const imageInfo = JSON.parse(await engine.run(["image", "inspect", row.image]))[0];
          if (imageInfo.Config?.Labels?.["fish.2kb.llm-chat.runtime"] !== "1") throw new Error("Use an image built from containers/Dockerfile (runtime version 1)");
          await engine.run(["create", "--name", row.container_name, "--label", `${OWNER_LABEL}=${this.owner}`,
            "--network", "host", "--init", ...(row.engine === "podman" && uid !== 0 ? ["--userns", "keep-id"] : []), "--user", "0:0", "--workdir", "/workdir",
            "--mount", bindMount(row.workspace_path, "/workdir"),
            "--mount", bindMount(attachments, "/attachments"),
            "--mount", bindMount(RUNTIME, "/opt/llm-chat-runtime", true),
            "--entrypoint", "/bin/sh", imageInfo.Id, "/opt/llm-chat-runtime/init.sh", String(uid), String(gid)]);
          info = await this.inspect(row);
        }
        if (!info?.State.Running) await engine.run(["start", row.container_name]);
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          signal?.throwIfAborted();
          try { await engine.run(["exec", row.container_name, "test", "-f", "/run/llm-chat/ready"], undefined, 3000); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        if (!ready) throw new Error("Container startup did not complete");
        const net = await engine.run(["exec", row.container_name, "readlink", "/proc/self/ns/net"]);
        if (net !== await readlink("/proc/self/ns/net")) throw new Error("The engine does not share this host's network namespace");
        for (const path of ["/etc/resolv.conf", "/etc/hosts"]) {
          await engine.run(["exec", "-i", "--user", "0", row.container_name, "/bin/sh", "-c", `cat > ${path}`], await readFile(path, "utf8"));
        }
        signal?.throwIfAborted();
        this.state(id, "running");
        this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
        const job = randomUUID();
        const launch = engine.command(["exec", "-i", ...(tty ? ["-t"] : []), "--user", `${uid}:${gid}`, "--env", "HOME=/home/llm-chat", "--env", "TERM=xterm-256color", "--workdir", cwd,
          row.container_name, "node", "/opt/llm-chat-runtime/runner.mjs", "run", job, command]);
        let released = false;
        return { ...launch, environmentId: id,
          stop: async (signal = "SIGTERM") => { await engine.run(["exec", "--user", `${uid}:${gid}`, row.container_name, "node", "/opt/llm-chat-runtime/runner.mjs", "stop", job, signal], undefined, 5000); },
          release: () => {
            if (released) return;
            released = true;
            this.leases.set(id, Math.max(0, (this.leases.get(id) ?? 1) - 1));
            this.store.sqlite.prepare("UPDATE conversation_environments SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
          }
        };
      } catch (error) {
        if (!this.leases.get(id)) { try { await this.stopRow(row); } catch {} }
        this.failed(id, error);
        throw error;
      }
    });
  }
  async execute(conversationId: string, config: ContainerConfig, selected: string | null, command: string, cwd: string, timeout: number, signal: AbortSignal): Promise<string> {
    const launch = await this.prepare(conversationId, config, selected, command, cwd, false, signal);
    try { return await executeProcess(launch.executable, launch.args, this.store.dataDir, timeout, signal, { env: process.env, onStop: launch.stop }); }
    finally { launch.release(); }
  }
  private async stopRow(row: EnvironmentRow): Promise<void> {
    if (await this.inspect(row)) await this.engines[row.engine].run(["stop", "--time", "3", row.container_name]);
    this.state(row.id, "stopped");
  }
  async stop(conversationId: string, id: string, reset = false): Promise<void> {
    await this.locked(conversationId, async () => {
      const row = this.rows(conversationId).find(entry => entry.id === id);
      if (!row) throw new Error("Environment not found");
      if (this.busy(row)) throw new Error("Stop active tools and background tasks first");
      await this.stopRow(row);
      if (reset) {
        if (await this.inspect(row)) await this.engines[row.engine].run(["rm", row.container_name]);
        this.store.sqlite.prepare("DELETE FROM conversation_environments WHERE id = ?").run(id);
      }
    });
  }
  async cleanupDeleted(): Promise<void> {
    for (const row of this.rows()) {
      if (this.store.getConversation(row.conversation_id)) continue;
      try {
        await this.stop(row.conversation_id, row.id, true);
      } catch (error) { this.failed(row.id, error); }
    }
    const root = resolve(this.store.dataDir, "container-workspaces");
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!this.store.getConversation(name) && this.rows(name).length === 0) {
        await rm(resolve(root, name), { recursive: true, force: true });
      }
    }
  }
  async sweep(now = Date.now()): Promise<void> {
    if (this.closing) return;
    for (const row of this.rows()) {
      if (row.status !== "running" && row.status !== "error") continue;
      await this.locked(row.conversation_id, async () => {
        const current = this.rows(row.conversation_id).find(entry => entry.id === row.id);
        if (current && !this.busy(current) && now - current.last_used_at >= current.idle_timeout_minutes * 60_000) {
          try { await this.stopRow(current); } catch (error) { this.failed(current.id, error); }
        }
      });
    }
    await this.cleanupDeleted();
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.locks.values()]);
    await Promise.all(this.rows().map(async row => { try { await this.stopRow(row); } catch (error) { this.failed(row.id, error); } }));
  }
}
