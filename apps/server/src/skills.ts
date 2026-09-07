import { createHash, randomUUID } from "node:crypto";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type { ApprovalPolicy, SkillDiscoverySummary, SkillDto } from "@llm-chat/contracts";
import { parseDocument } from "yaml";
import type { GenerationRecord, Store } from "./database";
import type { EventHub } from "./events";
import type { ServerTool } from "./tools";

type Row = Record<string, unknown>;
type SkillSourceKind = "bundled" | "manual" | "agents";

interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  compatibility: string | null;
  requiredTools: string[];
  recommendedApprovals: Record<string, ApprovalPolicy>;
}

export interface SkillManagerOptions {
  discoveryRoot?: string;
  agentsSkillsRoot?: string;
}

const BUNDLED: Array<{ id: string; content: string }> = [
  {
    id: "command-execution-guide",
    content: `---
id: command-execution-guide
name: Command Execution Guide
description: Choose correctly between foreground shell commands and durable background tasks.
requiredTools: workspace_shell, background_start, background_list, background_status, background_read, background_wait, background_write, background_stop
recommendedApprovals: workspace_shell=always, background_start=always, background_write=never, background_stop=never
---
# Command Execution Guide

Use \`workspace_shell\` for short, non-interactive commands when their complete result is needed before the next reasoning step. It has a maximum timeout of 120 seconds. Examples include \`fastfetch\`, a focused test, reading command output, or a quick build that is expected to finish within the limit.

Use \`background_start\` when a command is interactive, may run longer than 120 seconds, starts a server or watcher, must survive the current model step, or needs later input and incremental observation. Use \`pipe\` mode for ordinary long-running commands and services. Use \`pty\` only for a TUI, REPL, coding harness, or another program that genuinely requires a terminal.

After starting a background task, retain its task id. Prefer \`background_wait\` to wait for new output or a state change, then use \`background_read\` with the returned cursor when more output is needed. Do not repeatedly poll without advancing the cursor. Use \`background_write\` only for an interactive task and include a concrete audit reason. Use \`background_stop\` only when the user requests cancellation, the task is no longer needed, or continuing is unsafe.

Do not put a quick command in the background merely because background tools are available. Do not use \`workspace_shell\` for servers, watchers, interactive programs, or work likely to exceed its timeout. Report command results only after the corresponding tool returns.
`
  },
  {
    id: "coding-supervisor",
    content: `---
id: coding-supervisor
name: Coding Supervisor
description: Supervise a generic CLI coding harness through background PTY tools.
requiredTools: background_start, background_list, background_status, background_read, background_wait, background_write, background_stop
recommendedApprovals: background_start=always, background_write=never, background_stop=never
---
# Coding Supervisor

Use generic background tools to supervise a full coding harness. Inspect the selected command's help before choosing flags. Start an interactive harness with \`background_start\` in PTY mode, tell the user what started, then alternate \`background_wait\` and \`background_read\` until it exits. When the harness asks for approval, inspect the request and use \`background_write\` to approve or deny it. Use \`background_stop\` only for an emergency or explicit user request. Never assume a provider-specific command line.
`
  },
  {
    id: "llm-chat-operator",
    content: `---
id: llm-chat-operator
name: llm-chat Operator
description: Inspect and manage this llm-chat instance, including Agents, Character Cards, roleplay workflows, conversations, connections, models, MCP servers, Skills, Plugins, and tool settings.
requiredTools: app_agents, app_conversations, app_settings, app_connections, app_models, app_mcp_servers, app_skills, app_plugins, app_tool_settings, app_roleplay
---
# llm-chat Operator

Use the \`app_*\` tools when the user asks you to inspect or change llm-chat itself. Do not edit the database, server configuration, or application files as a substitute for these tools.

Read the relevant current state before changing it. Apply only the fields the user asked to change, then read the result back when verification matters. Do not claim success until the management tool returns successfully.

For Character Cards, prefer \`app_agents\` import with a current-conversation attachment when the user supplied a card file or image. Public URLs and workspace files are alternatives only when the user identifies them. Preserve card data that the user did not ask to replace.

Use \`app_roleplay\` for Agent-owned presets, personas, lorebooks, safe regex, quick replies, and current-conversation roleplay state. Roleplay changes must remain scoped to the selected Agent or conversation. The restricted script action can only change roleplay state and draft text; it cannot run JavaScript, shell commands, or network requests. Read the script audit log when verification matters.

Management tools intentionally cannot reveal or write API keys and secret headers. Explain that boundary and direct the user to the connection or MCP editor for secret-bearing fields; never ask them to paste a secret into chat merely to work around the boundary.

Creating and updating the requested object is allowed when the request is explicit. Before deleting a conversation, Agent, model, connection, Plugin, or another durable object, confirm the exact target unless the user already explicitly authorized that deletion. Do not start model generations or compact conversations through indirect workarounds.
`
  },
  {
    id: "tool-author",
    content: `---
id: tool-author
name: Tool Author
description: Author and manage isolated ESM tool plugins.
requiredTools: workspace_list, workspace_read_file, workspace_write_file, workspace_edit_file, workspace_shell
recommendedApprovals: workspace_write_file=always, workspace_edit_file=always, workspace_shell=always
---
# Tool Author

Create an ESM plugin directory in the conversation workspace. Add \`plugin.json\` with \`id\`, \`name\`, \`version\`, \`apiVersion: 1\`, and \`entry\`. Export \`register(api)\` from the entry and call \`api.registerTool\` for each tool. Keep schemas explicit. Use stable local tool names. Plugin dependencies require \`pnpm-lock.yaml\`; installation uses a frozen production install. Ask the owner to install or reload the managed copy after source changes.
`
  }
];

export class SkillManager {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly discoveryRoot: string;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly events: EventHub,
    options: SkillManagerOptions | string = {}
  ) {
    const configured = typeof options === "string"
      ? options
      : options.discoveryRoot ?? options.agentsSkillsRoot;
    this.discoveryRoot = resolve(configured ?? resolve(homedir(), ".agents", "skills"));
  }

  async initialize(): Promise<void> {
    const bundledRoot = resolve(this.store.dataDir, ".bundled-skills");
    await mkdir(bundledRoot, { recursive: true, mode: 0o700 });
    for (const skill of BUNDLED) {
      const path = resolve(bundledRoot, skill.id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(resolve(path, "SKILL.md"), skill.content, { mode: 0o600 });
      await this.activateSource(path, "bundled");
    }
    const legacy = resolve(this.store.dataDir, "skills");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(legacy, { withFileTypes: true })) {
      if (!entry.isDirectory() || this.list().some((skill) => skill.id === entry.name)) continue;
      try { await this.activateSource(resolve(legacy, entry.name), "manual"); } catch {}
    }
    await this.discover();
  }

  list(): SkillDto[] {
    return (this.store.sqlite.prepare(`
      SELECT * FROM skill_installations
      ORDER BY bundled DESC, name COLLATE NOCASE, id
    `).all() as Row[]).map(skillDto);
  }

  install(sourcePath: string, bundled = false): Promise<SkillDto> {
    return this.activateSource(sourcePath, bundled ? "bundled" : "manual");
  }

  async discover(): Promise<SkillDiscoverySummary> {
    const summary: SkillDiscoverySummary = {
      discovered: 0, updated: 0, unchanged: 0, unloaded: 0, errors: []
    };
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.discoveryRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        summary.errors.push({ path: this.discoveryRoot, message: errorMessage(error) });
        return summary;
      }
      entries = [];
    }

    const candidatePaths = new Set<string>();
    const directories = entries.filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directories) {
      const source = resolve(this.discoveryRoot, entry.name);
      const skillFile = resolve(source, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf8");
        candidatePaths.add(source);
        const metadata = parseMetadata(content, entry.name, "agents");
        const existing = this.list().find((skill) => skill.id === metadata.id);
        if (existing && existing.sourceKind !== "agents") {
          throw new Error(`Discovered Skill id conflicts with ${existing.sourceKind ?? "manual"} Skill ${existing.id}`);
        }
        const revision = await hashTree(source);
        if (!existing) {
          await this.activateSource(source, "agents", metadata, revision);
          summary.discovered += 1;
          continue;
        }

        const staged = this.store.sqlite.prepare(
          "SELECT 1 FROM skill_revisions WHERE skill_id = ? AND revision = ?"
        ).get(existing.id, revision);
        if (existing.revision === revision) {
          const changedState = existing.state !== "loaded" || existing.error !== null || existing.sourcePath !== source;
          this.store.sqlite.prepare(`
            UPDATE skill_installations SET source_path = ?, state = 'loaded', error = NULL,
              name = ?, description = ?, compatibility = ?, required_tools_json = ?,
              recommended_approvals_json = ?, updated_at = CASE WHEN state = 'loaded' AND error IS NULL
                AND source_path = ? THEN updated_at ELSE ? END
            WHERE id = ?
          `).run(source, metadata.name, metadata.description, metadata.compatibility,
            JSON.stringify(metadata.requiredTools), JSON.stringify(metadata.recommendedApprovals), source, Date.now(), existing.id);
          this.watchSource(existing.id, source);
          if (changedState) summary.updated += 1; else summary.unchanged += 1;
          continue;
        }
        if (!staged) {
          const revisionPath = await this.stageRevision(existing.id, source, revision);
          this.store.sqlite.prepare("INSERT INTO skill_revisions (skill_id, revision, path, created_at) VALUES (?, ?, ?, ?)")
            .run(existing.id, revision, revisionPath, Date.now());
        }
        this.store.sqlite.prepare(`
          UPDATE skill_installations SET source_path = ?, state = 'pending-reload', error = NULL, updated_at = ?
          WHERE id = ?
        `).run(source, Date.now(), existing.id);
        this.watchSource(existing.id, source);
        if (staged && existing.state === "pending-reload") summary.unchanged += 1;
        else {
          summary.updated += 1;
          this.events.emit({ type: "skill", skillId: existing.id, state: "pending-reload", message: "源文件已更改" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        summary.errors.push({ path: skillFile, message: errorMessage(error) });
        const existing = this.list().find((skill) => skill.sourceKind === "agents" && skill.sourcePath === source);
        if (existing) {
          this.store.sqlite.prepare("UPDATE skill_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ?")
            .run(errorMessage(error), Date.now(), existing.id);
          this.events.emit({ type: "skill", skillId: existing.id, state: "error", message: errorMessage(error) });
        }
      }
    }

    for (const skill of this.list().filter((item) => item.sourceKind === "agents" && !candidatePaths.has(item.sourcePath))) {
      if (skill.state === "unloaded") continue;
      this.watchers.get(skill.id)?.close();
      this.watchers.delete(skill.id);
      this.store.sqlite.prepare("UPDATE skill_installations SET state = 'unloaded', error = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), skill.id);
      this.events.emit({ type: "skill", skillId: skill.id, state: "unloaded", message: "发现源已不存在" });
      summary.unloaded += 1;
    }
    return summary;
  }

  async remove(id: string): Promise<void> {
    const skill = this.list().find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    if (skill.bundled) throw new Error("Bundled skills cannot be removed");
    if (this.usedByActiveGeneration(id)) throw new Error("Skill is pinned by an active generation");
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.store.sqlite.prepare("DELETE FROM skill_installations WHERE id = ?").run(id);
    await rm(resolve(this.store.dataDir, "managed-skills", id), { recursive: true, force: true });
  }

  activeRevisions(enabledIds: string[]): Record<string, string> {
    const enabled = new Set(enabledIds);
    return Object.fromEntries(this.list()
      .filter((skill) => enabled.has(skill.id) && (skill.state === "loaded" || skill.state === "pending-reload"))
      .map((skill) => [skill.id, skill.revision]));
  }

  async reload(id: string): Promise<SkillDto> {
    const skill = this.list().find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    return this.activateSource(skill.sourcePath, skill.sourceKind ?? (skill.bundled ? "bundled" : "manual"));
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  tool(record?: GenerationRecord): ServerTool {
    const current = this.list().filter((skill) => skill.state === "loaded" || skill.state === "pending-reload");
    const available = record ? Object.keys(record.agentSnapshot.skillRevisions).length > 0 : current.length > 0;
    const selectedIds = record ? new Set(Object.keys(record.agentSnapshot.skillRevisions)) : null;
    const descriptions = current.filter((skill) => !selectedIds || selectedIds.has(skill.id))
      .map((skill) => `${skill.id}: ${skill.description}`).join("; ");
    const pinned = (input: Record<string, unknown>): { id: string; revision: string } => {
      const id = typeof input.id === "string" ? input.id : typeof input.name === "string" ? input.name : "";
      const revision = record?.agentSnapshot.skillRevisions[id] ?? current.find((skill) => skill.id === id)?.revision;
      if (!revision || (record && !record.agentSnapshot.skillRevisions[id])) {
        throw new Error("Skill is not enabled for this Agent snapshot");
      }
      return { id, revision };
    };
    return {
      definition: {
        name: "use_skill",
        description: `Load an enabled skill or one of its referenced files. ${descriptions}`,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, path: { type: "string" } },
          required: ["id"]
        }
      },
      label: "加载 Skill",
      category: "skill",
      available,
      sourceKind: "builtin",
      requiresApproval: () => false,
      activatesTools: async (input) => {
        const { id, revision } = pinned(input);
        const content = await readFile(resolve(this.revisionPath(id, revision), "SKILL.md"), "utf8");
        return parseMetadata(content, id, "manual").requiredTools;
      },
      execute: async (input) => {
        const { id, revision } = pinned(input);
        const root = this.revisionPath(id, revision);
        const relative = typeof input.path === "string" && input.path ? input.path : "SKILL.md";
        const target = resolve(root, relative);
        if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Skill path escapes its revision");
        const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(target));
        if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
          throw new Error("Skill file resolves outside its revision");
        }
        return readFile(canonical, "utf8");
      }
    };
  }

  private async activateSource(
    sourcePath: string,
    sourceKind: SkillSourceKind,
    suppliedMetadata?: SkillMetadata,
    suppliedRevision?: string
  ): Promise<SkillDto> {
    const source = resolve(sourcePath);
    if (!(await stat(source)).isDirectory()) throw new Error("Skill source must be a directory");
    const content = await readFile(resolve(source, "SKILL.md"), "utf8");
    const fallback = source.split(sep).at(-1) || "skill";
    const metadata = suppliedMetadata ?? parseMetadata(content, fallback, sourceKind);
    const existing = this.list().find((item) => item.id === metadata.id);
    if (existing && existing.sourceKind !== sourceKind) {
      throw new Error(`Skill id ${metadata.id} is already owned by ${existing.sourceKind ?? "manual"}`);
    }
    const revision = suppliedRevision ?? await hashTree(source);
    const finalPath = await this.stageRevision(metadata.id, source, revision);
    const now = Date.now();
    try {
      this.store.sqlite.prepare(`
        INSERT INTO skill_installations (id, name, description, source_path, active_revision, state, error,
          required_tools_json, recommended_approvals_json, bundled, source_kind, compatibility, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'loaded', NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
          source_path = excluded.source_path, active_revision = excluded.active_revision, state = 'loaded', error = NULL,
          required_tools_json = excluded.required_tools_json, recommended_approvals_json = excluded.recommended_approvals_json,
          bundled = MAX(skill_installations.bundled, excluded.bundled), source_kind = excluded.source_kind,
          compatibility = excluded.compatibility, updated_at = excluded.updated_at
      `).run(metadata.id, metadata.name, metadata.description, source, revision, JSON.stringify(metadata.requiredTools),
        JSON.stringify(metadata.recommendedApprovals), sourceKind === "bundled" ? 1 : 0, sourceKind,
        metadata.compatibility, existing?.installedAt ?? now, now);
      this.store.sqlite.prepare("INSERT OR IGNORE INTO skill_revisions (skill_id, revision, path, created_at) VALUES (?, ?, ?, ?)")
        .run(metadata.id, revision, finalPath, now);
      const skill = this.list().find((item) => item.id === metadata.id)!;
      if (sourceKind !== "bundled") this.watchSource(skill.id, source);
      this.events.emit({ type: "skill", skillId: skill.id, state: skill.state });
      return skill;
    } catch (error) {
      if (existing) {
        const message = errorMessage(error);
        this.store.sqlite.prepare("UPDATE skill_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ?")
          .run(message, Date.now(), metadata.id);
        this.events.emit({ type: "skill", skillId: metadata.id, state: "error", message });
      }
      throw error;
    }
  }

  private async stageRevision(id: string, source: string, revision: string): Promise<string> {
    const base = resolve(this.store.dataDir, "managed-skills", id);
    const finalPath = resolve(base, "revisions", revision);
    const existing = this.store.sqlite.prepare(
      "SELECT path FROM skill_revisions WHERE skill_id = ? AND revision = ?"
    ).get(id, revision) as Row | undefined;
    if (existing) return String(existing.path);
    const staging = resolve(base, `.staging-${randomUUID()}`);
    await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
    try {
      await cp(source, staging, {
        recursive: true,
        filter: (path) => !path.split(sep).some((part) => part === ".git" || part === "node_modules")
      });
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      try {
        await rename(staging, finalPath);
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      return finalPath;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
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
          try {
            this.store.sqlite.prepare("UPDATE skill_installations SET state = 'pending-reload', updated_at = ? WHERE id = ?")
              .run(Date.now(), id);
            this.events.emit({ type: "skill", skillId: id, state: "pending-reload", message: "源文件已更改" });
          } catch {
            // The source notification can race service shutdown.
          }
        }, 250);
      });
      this.watchers.set(id, watcher);
    } catch {}
  }

  private revisionPath(id: string, revision: string): string {
    const row = this.store.sqlite.prepare("SELECT path FROM skill_revisions WHERE skill_id = ? AND revision = ?")
      .get(id, revision) as Row | undefined;
    if (!row) throw new Error("Skill revision not found");
    return String(row.path);
  }

  private usedByActiveGeneration(id: string): boolean {
    const rows = this.store.sqlite.prepare(
      "SELECT agent_snapshot_json FROM generations WHERE status IN ('queued','running','waiting-approval')"
    ).all() as Row[];
    return rows.some((row) => {
      try {
        const snapshot = JSON.parse(String(row.agent_snapshot_json ?? "{}")) as { skillRevisions?: Record<string, string> };
        return Boolean(snapshot.skillRevisions?.[id]);
      } catch {
        return false;
      }
    });
  }
}

function skillDto(row: Row): SkillDto {
  const storedKind = String(row.source_kind ?? "");
  const sourceKind: SkillSourceKind = storedKind === "agents" || storedKind === "bundled" || storedKind === "manual"
    ? storedKind
    : Boolean(row.bundled) ? "bundled" : "manual";
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    revision: String(row.active_revision),
    sourcePath: String(row.source_path),
    state: row.state as SkillDto["state"],
    error: row.error === null ? null : String(row.error),
    requiredTools: parseStoredArray(row.required_tools_json),
    recommendedApprovals: parseStoredApprovals(row.recommended_approvals_json),
    bundled: Boolean(row.bundled),
    sourceKind,
    compatibility: row.compatibility === null || row.compatibility === undefined ? null : String(row.compatibility),
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at)
  };
}

function parseMetadata(content: string, fallbackId: string, sourceKind: SkillSourceKind): SkillMetadata {
  const frontmatter = extractFrontmatter(content);
  const fields = frontmatter === null ? {} : parseYamlMap(
    sourceKind === "agents" ? frontmatter : normalizeLegacyFrontmatter(frontmatter)
  );
  if (sourceKind === "agents") validateAgentSkillFields(fields, fallbackId, frontmatter !== null);
  const rawId = sourceKind === "agents" ? `agents.${String(fields.name)}` : scalarString(fields.id) || fallbackId;
  const id = sourceKind === "agents"
    ? rawId
    : rawId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
  if (!id || id.length > 100) throw new Error("Skill id is invalid");
  const name = scalarString(fields.name) || id;
  const description = scalarString(fields.description) || "";
  const compatibility = fields.compatibility === undefined || fields.compatibility === null
    ? null
    : scalarString(fields.compatibility, "compatibility");
  return {
    id,
    name,
    description,
    compatibility,
    requiredTools: parseRequiredTools(fields.requiredTools),
    recommendedApprovals: parseRecommendedApprovals(fields.recommendedApprovals)
  };
}

function normalizeLegacyFrontmatter(source: string): string {
  return source.replace(/^(id:\s*)(!+)(\s*)$/m, (_line, prefix: string, value: string, suffix: string) =>
    `${prefix}${JSON.stringify(value)}${suffix}`);
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function parseYamlMap(source: string): Record<string, unknown> {
  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length) throw new Error(`Invalid Skill YAML frontmatter: ${document.errors[0]!.message}`);
  const value = document.toJS({ maxAliasCount: 20 }) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Skill YAML frontmatter must be a map");
  }
  return value as Record<string, unknown>;
}

function validateAgentSkillFields(fields: Record<string, unknown>, directoryName: string, hasFrontmatter: boolean): void {
  if (!hasFrontmatter) throw new Error("Agent Skill must have YAML frontmatter");
  const name = scalarString(fields.name, "name");
  const description = scalarString(fields.description, "description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Agent Skill name must be 1-64 lowercase letters, numbers, or single hyphens");
  }
  if (name !== directoryName) throw new Error(`Agent Skill name ${name} must match parent directory ${directoryName}`);
  if (!description.trim() || description.length > 1024) {
    throw new Error("Agent Skill description must be 1-1024 characters");
  }
  if (fields.compatibility !== undefined && fields.compatibility !== null) {
    const compatibility = scalarString(fields.compatibility, "compatibility");
    if (compatibility.length > 500) throw new Error("Agent Skill compatibility must be at most 500 characters");
  }
}

function scalarString(value: unknown, field?: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`Skill ${field ?? "metadata"} must be a string`);
  return value.trim();
}

function parseRequiredTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const names = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value)
      ? value
      : typeof value === "object"
        ? Object.entries(value as Record<string, unknown>).filter(([, enabled]) => enabled !== false && enabled !== null).map(([name]) => name)
        : [];
  return [...new Set(names.map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean))];
}

function parseRecommendedApprovals(value: unknown): Record<string, ApprovalPolicy> {
  const result: Record<string, ApprovalPolicy> = {};
  const add = (tool: unknown, policy: unknown) => {
    if (typeof tool !== "string" || !tool.trim()) return;
    if (policy === "default" || policy === "always" || policy === "never") result[tool.trim()] = policy;
  };
  if (typeof value === "string") {
    for (const pair of value.split(",")) {
      const [tool, policy] = pair.split("=").map((part) => part.trim());
      add(tool, policy);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const [tool, policy] = item.split("=").map((part) => part.trim());
        add(tool, policy);
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if ("tool" in record) add(record.tool, record.policy);
        else for (const [tool, policy] of Object.entries(record)) add(tool, policy);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [tool, policy] of Object.entries(value as Record<string, unknown>)) add(tool, policy);
  }
  return result;
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isSymbolicLink()) throw new Error("Skill sources cannot contain symbolic links");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) hash.update(await readFile(path));
    }
  };
  await walk(root);
  return hash.digest("hex").slice(0, 24);
}

function parseStoredArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseStoredApprovals(value: unknown): Record<string, ApprovalPolicy> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, ApprovalPolicy>
      : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
