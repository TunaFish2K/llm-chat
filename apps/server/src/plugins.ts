import { normalizeToolMarkdown } from "./tool-presentation";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginDto, PluginManifest } from "@llm-chat/contracts";
import { pluginManifestSchema } from "@llm-chat/contracts";
import { toolValidators, validateToolInput, validationErrors } from "./tool-validation";
import type { Store } from "./database";
import type { GenerationRecord } from "./generation-types";
import type { EventHub } from "./events";
import type { ServerTool } from "./tools";

type Row = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type HostTool = { formatArguments?: boolean; formatResult?: boolean; name: string; label: string; description: string; category: string; inputSchema: Record<string, unknown>; approvalMode: "always" | "never" | "dynamic" };
type HostMessage = { id?: string; type: string; tools?: HostTool[]; ok?: boolean; result?: unknown; error?: string };

class PluginHost {
  readonly tools: HostTool[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready?: Promise<void>;
  private closing = false;

  constructor(private readonly entry: string, private readonly config: JsonObject, private readonly secrets: JsonObject, private readonly onCrash: (message: string) => void) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const sourceHost = resolve(dirname(fileURLToPath(import.meta.url)), "plugin-host.ts");
      const builtHost = resolve(dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
      const development = fileURLToPath(import.meta.url).endsWith(".ts");
      const args = [
        ...(development ? ["--import", "tsx", sourceHost] : [builtHost]),
        this.entry
      ];
      const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); rejectReady(new Error("Plugin registration timed out")); }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) child.kill("SIGKILL");
        let newline = stdout.indexOf("\n");
        while (newline >= 0) {
          const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1); this.message(line, resolveReady, rejectReady, timer);
          newline = stdout.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
      child.on("error", (error) => { clearTimeout(timer); rejectReady(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        const error = new Error(stderr || `Plugin host exited with code ${code}`);
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        if (this.closing) return;
        if (this.tools.length) this.onCrash(error.message); else rejectReady(error);
      });
      child.stdin.write(`${JSON.stringify({ type: "initialize", config: this.config, secrets: this.secrets })}\n`);
    });
    return this.ready;
  }

  async request(type: "approval" | "execute" | "format-arguments" | "format-result", tool: string, input: JsonObject, context: JsonObject = {}, presentation: { output?: string | null; error?: string | null } = {}): Promise<unknown> {
    await this.start();
    if (!this.child || this.child.exitCode !== null) throw new Error("Plugin host is not running");
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Plugin call timed out")); }, type.startsWith("format-") ? 1000 : 120_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, type, tool, input, context, ...presentation })}\n`);
    });
  }

  close(): void { this.closing = true; this.child?.kill("SIGTERM"); }

  private message(line: string, resolveReady: () => void, rejectReady: (error: Error) => void, readyTimer: NodeJS.Timeout): void {
    let message: HostMessage;
    try { message = JSON.parse(line) as HostMessage; } catch { return; }
    if (message.type === "ready" && message.tools) {
      this.tools.splice(0, this.tools.length, ...message.tools);
      clearTimeout(readyTimer); resolveReady(); return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error || "Plugin call failed"));
  }
}

export class PluginManager {
  private readonly hosts = new Map<string, PluginHost>();
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;

  constructor(private readonly store: Store, private readonly events: EventHub) {}

  list(): PluginDto[] {
    return (this.store.sqlite.prepare("SELECT * FROM plugin_installations ORDER BY updated_at DESC").all() as Row[]).map(pluginDto);
  }

  async install(sourcePath: string): Promise<PluginDto> {
    const source = resolve(sourcePath);
    if (!(await stat(source)).isDirectory()) throw new Error("Plugin source must be a directory");
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(resolve(source, "plugin.json"), "utf8")));
    const packagePath = resolve(source, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { dependencies?: JsonObject; optionalDependencies?: JsonObject };
      if (Object.keys(packageJson.dependencies ?? {}).length || Object.keys(packageJson.optionalDependencies ?? {}).length) {
        await stat(resolve(source, "pnpm-lock.yaml"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const revision = await hashTree(source);
    const existing = this.list().find((item) => item.id === manifest.id);
    const base = resolve(this.store.dataDir, "plugins", manifest.id);
    const finalPath = resolve(base, "revisions", revision);
    const staging = resolve(base, `.staging-${randomUUID()}`);
    await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
    try {
      await cp(source, staging, { recursive: true, filter: (path) => !path.split(sep).some((part) => part === ".git" || part === "node_modules") });
      const entryInfo = await stat(pluginEntry(staging, manifest));
      if (!entryInfo.isFile()) throw new Error("Plugin entry must be a file");
      try {
        await stat(resolve(staging, "pnpm-lock.yaml"));
        await runPnpm(staging);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      try { await rename(staging, finalPath); } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      await this.validateRevision(
        manifest,
        revision,
        finalPath,
        existing?.config ?? {},
        existing ? this.secretValues(manifest.id) : {},
      );
      const now = Date.now();
      this.store.sqlite.prepare(`
        INSERT INTO plugin_installations (id, manifest_json, source_path, active_revision, state, error, config_json, secrets_json, installed_at, updated_at)
        VALUES (?, ?, ?, ?, 'loaded', NULL, '{}', '{}', ?, ?)
        ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, source_path = excluded.source_path, active_revision = excluded.active_revision,
          state = 'loaded', error = NULL, updated_at = excluded.updated_at
      `).run(manifest.id, JSON.stringify(manifest), source, revision, existing?.installedAt ?? now, now);
      this.store.sqlite.prepare("INSERT OR IGNORE INTO plugin_revisions (plugin_id, revision, path, created_at) VALUES (?, ?, ?, ?)")
        .run(manifest.id, revision, finalPath, now);
      const cached = this.hosts.get(`${manifest.id}@${revision}`);
      cached?.close();
      this.hosts.delete(`${manifest.id}@${revision}`);
      const plugin = this.list().find((item) => item.id === manifest.id)!;
      this.watchSource(plugin.id, source);
      this.events.emit({ type: "plugin", pluginId: plugin.id, state: plugin.state });
      return plugin;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (existing) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ?")
          .run(message, Date.now(), manifest.id);
        this.events.emit({ type: "plugin", pluginId: manifest.id, state: "error", message });
      }
      throw error;
    }
  }

  configure(id: string, config: JsonObject, secrets: JsonObject): PluginDto {
    const plugin = this.list().find((item) => item.id === id);
    if (!plugin) throw new Error("Plugin not found");
    if (plugin.manifest.configSchema) {
      const validate = toolValidators.get(plugin.manifest.configSchema);
      if (!validate(config)) throw new Error(validationErrors(validate.errors));
    }
    const current = this.secretValues(id);
    const allowedSecrets = Object.fromEntries(Object.entries(secrets).filter(([key]) => plugin.manifest.secretFields.includes(key)));
    this.store.sqlite.prepare("UPDATE plugin_installations SET config_json = ?, secrets_json = ?, state = 'pending-reload', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), JSON.stringify({ ...current, ...allowedSecrets }), Date.now(), id);
    return this.list().find((item) => item.id === id)!;
  }

  configurePublic(id: string, config: JsonObject): PluginDto {
    return this.configure(id, config, this.secretValues(id));
  }

  async reload(id: string): Promise<PluginDto> {
    const plugin = this.list().find((item) => item.id === id);
    if (!plugin) throw new Error("Plugin not found");
    if (plugin.sourcePath) return this.install(plugin.sourcePath);
    const path = this.revisionPath(id, plugin.revision);
    await this.validateRevision(plugin.manifest, plugin.revision, path, plugin.config, this.secretValues(id));
    this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'loaded', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.list().find((item) => item.id === id)!;
  }

  unload(id: string): PluginDto {
    if (!this.list().some((item) => item.id === id)) throw new Error("Plugin not found");
    this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'unloaded', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.list().find((item) => item.id === id)!;
  }

  async remove(id: string): Promise<void> {
    if (!this.list().some((item) => item.id === id)) throw new Error("Plugin not found");
    if (this.usedByActiveGeneration(id)) throw new Error("Plugin is pinned by an active generation");
    this.watchers.get(id)?.close(); this.watchers.delete(id);
    for (const [key, host] of this.hosts) if (key.startsWith(`${id}@`)) { host.close(); this.hosts.delete(key); }
    this.store.sqlite.prepare("DELETE FROM plugin_installations WHERE id = ?").run(id);
    await rm(resolve(this.store.dataDir, "plugins", id), { recursive: true, force: true });
  }

  async tools(record?: GenerationRecord): Promise<ServerTool[]> {
    const tools: ServerTool[] = [];
    const installed = this.list();
    const selected = record
      ? Object.keys(record.agentSnapshot.toolRevisions).map((id) => installed.find((item) => item.id === id)).filter((item): item is PluginDto => Boolean(item))
      : installed.filter((item) => item.state === "loaded" || item.state === "pending-reload");
    for (const plugin of selected) {
      const revision = record?.agentSnapshot.toolRevisions[plugin.id] ?? plugin.revision;
      const manifest = await this.revisionManifest(plugin.id, revision);
      const host = await this.host(plugin.id, revision);
      for (const remote of host.tools) {
        toolValidators.get(remote.inputSchema);
        const canonical = `plugin__${plugin.id}__${remote.name}`;
        tools.push({
          definition: { name: canonical, description: remote.description, inputSchema: remote.inputSchema },
          label: `${manifest.name} / ${remote.label}`, category: "plugin", available: true,
          sourceKind: "plugin", sourceId: plugin.id, sourceName: manifest.name, revision,
          ...(remote.formatArguments ? { formatArguments: async (input: JsonObject) => normalizeToolMarkdown(await (await this.host(plugin.id, revision)).request("format-arguments", remote.name, input)) ?? {} } : {}),
          ...(remote.formatResult ? { formatResult: async ({ input, output, error }: import("@llm-chat/contracts").ToolResultFormatInput) => normalizeToolMarkdown(await (await this.host(plugin.id, revision)).request("format-result", remote.name, input, {}, { output, error })) ?? {} } : {}),
          requiresApproval: async (input) => {
            if (remote.approvalMode === "always") return true;
            if (remote.approvalMode === "never") return false;
            return Boolean(await this.callWithRestart(plugin.id, revision, "approval", remote.name, input, {}));
          },
          execute: async (input, _signal, context) => {
            validateToolInput(canonical, remote.inputSchema, input);
            const result = await this.callWithRestart(plugin.id, revision, "execute", remote.name, input, context ? {
              conversationId: context.conversationId, generationId: context.generationId, toolCallId: context.toolCallId,
              agentId: context.snapshot.agentId, agentRevision: context.snapshot.revision, workspacePath: context.snapshot.workspacePath
            } : {});
            return String(result ?? "");
          }
        });
      }
    }
    return tools;
  }

  activeRevisions(): Record<string, string> {
    return Object.fromEntries(this.list().filter((item) => item.state === "loaded" || item.state === "pending-reload").map((item) => [item.id, item.revision]));
  }

  close(): void {
    this.closed = true;
    for (const host of this.hosts.values()) host.close(); this.hosts.clear();
    for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
  }

  private watchSource(id: string, path: string): void {
    this.watchers.get(id)?.close();
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(path, { recursive: true }, (_event, file) => {
        if (!file || String(file).split(/[\\/]/).some((part) => part === ".git" || part === "node_modules")) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.closed) return;
          this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'pending-reload', updated_at = ? WHERE id = ? AND state != 'unloaded'").run(Date.now(), id);
          this.events.emit({ type: "plugin", pluginId: id, state: "pending-reload", message: "源文件已更改" });
        }, 250);
      });
      this.watchers.set(id, watcher);
    } catch {}
  }

  private async callWithRestart(id: string, revision: string, type: "approval" | "execute", tool: string, input: JsonObject, context: JsonObject): Promise<unknown> {
    try { return await (await this.host(id, revision)).request(type, tool, input, context); }
    catch (first) {
      const key = `${id}@${revision}`;
      this.hosts.get(key)?.close(); this.hosts.delete(key);
      try { return await (await this.host(id, revision)).request(type, tool, input, context); }
      catch (second) {
        const message = second instanceof Error ? second.message : String(second);
        const changed = this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ? AND active_revision = ?")
          .run(message, Date.now(), id, revision).changes;
        if (changed) this.events.emit({ type: "plugin", pluginId: id, state: "error", message });
        throw second ?? first;
      }
    }
  }

  private async validateRevision(manifest: PluginManifest, revision: string, path: string, config: JsonObject, secrets: JsonObject): Promise<void> {
    const host = new PluginHost(pluginEntry(path, manifest), config, secrets, () => {});
    await host.start(); host.close();
    if (!host.tools.length) throw new Error("Plugin did not register any tools");
    const names = new Set<string>();
    for (const tool of host.tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate plugin tool: ${tool.name}`);
      names.add(tool.name); toolValidators.get(tool.inputSchema);
    }
    void revision;
  }

  private async host(id: string, revision: string): Promise<PluginHost> {
    const key = `${id}@${revision}`;
    const existing = this.hosts.get(key);
    if (existing) { await existing.start(); return existing; }
    const plugin = this.list().find((item) => item.id === id);
    if (!plugin) throw new Error("Plugin not found");
    const path = this.revisionPath(id, revision);
    const manifest = await this.revisionManifest(id, revision);
    const host = new PluginHost(pluginEntry(path, manifest), plugin.config, this.secretValues(id), (message) => {
      if (this.closed) return;
      const changed = this.store.sqlite.prepare("UPDATE plugin_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ? AND active_revision = ?")
        .run(message, Date.now(), id, revision).changes;
      if (changed) this.events.emit({ type: "plugin", pluginId: id, state: "error", message });
    });
    this.hosts.set(key, host); await host.start(); return host;
  }

  private revisionPath(id: string, revision: string): string {
    const row = this.store.sqlite.prepare("SELECT path FROM plugin_revisions WHERE plugin_id = ? AND revision = ?").get(id, revision) as Row | undefined;
    if (!row) throw new Error("Plugin revision not found");
    return String(row.path);
  }

  private async revisionManifest(id: string, revision: string): Promise<PluginManifest> {
    return pluginManifestSchema.parse(JSON.parse(await readFile(resolve(this.revisionPath(id, revision), "plugin.json"), "utf8")));
  }

  private usedByActiveGeneration(id: string): boolean {
    const rows = this.store.sqlite.prepare("SELECT agent_snapshot_json FROM generations WHERE status IN ('queued','running','waiting-approval')").all() as Row[];
    return rows.some((row) => {
      try {
        const snapshot = JSON.parse(String(row.agent_snapshot_json ?? "{}")) as { toolRevisions?: Record<string, string> };
        return Boolean(snapshot.toolRevisions?.[id]);
      } catch { return false; }
    });
  }

  private secretValues(id: string): JsonObject {
    const row = this.store.sqlite.prepare("SELECT secrets_json FROM plugin_installations WHERE id = ?").get(id) as Row | undefined;
    return row ? parseObject(row.secrets_json) : {};
  }
}

function pluginDto(row: Row): PluginDto {
  const manifest = pluginManifestSchema.parse(JSON.parse(String(row.manifest_json)));
  const secrets = parseObject(row.secrets_json);
  return {
    id: String(row.id), manifest, revision: String(row.active_revision), sourcePath: String(row.source_path), state: row.state as PluginDto["state"],
    error: row.error === null ? null : String(row.error), config: parseObject(row.config_json),
    configuredSecretFields: manifest.secretFields.filter((key) => Boolean(secrets[key])),
    installedAt: Number(row.installed_at), updatedAt: Number(row.updated_at)
  };
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name); hash.update(path.slice(root.length));
      if (entry.isSymbolicLink()) throw new Error("Plugin sources cannot contain symbolic links");
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) hash.update(await readFile(path));
    }
  };
  await walk(root); return hash.digest("hex").slice(0, 24);
}

function pluginEntry(root: string, manifest: PluginManifest): string {
  const entry = resolve(root, manifest.entry);
  if (entry === root || !entry.startsWith(`${root}${sep}`)) throw new Error("Plugin entry must be inside its revision");
  return entry;
}

async function runPnpm(cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `pnpm exited with ${code}`)));
  });
}

function parseObject(value: unknown): JsonObject {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {}; }
  catch { return {}; }
}
