import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ApprovalPolicy, SkillDto } from "@llm-chat/contracts";
import type { GenerationRecord, Store } from "./database";
import type { EventHub } from "./events";
import type { ServerTool } from "./tools";

type Row = Record<string, unknown>;

const BUNDLED: Array<{ id: string; content: string }> = [
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
  private closed = false;
  constructor(private readonly store: Store, private readonly events: EventHub) {}

  async initialize(): Promise<void> {
    const bundledRoot = resolve(this.store.dataDir, ".bundled-skills");
    await mkdir(bundledRoot, { recursive: true, mode: 0o700 });
    for (const skill of BUNDLED) {
      const path = resolve(bundledRoot, skill.id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(resolve(path, "SKILL.md"), skill.content, { mode: 0o600 });
      await this.install(path, true);
    }
    const legacy = resolve(this.store.dataDir, "skills");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(legacy, { withFileTypes: true })) {
      if (!entry.isDirectory() || this.list().some((skill) => skill.id === entry.name)) continue;
      try { await this.install(resolve(legacy, entry.name), false); } catch {}
    }
  }

  list(): SkillDto[] {
    return (this.store.sqlite.prepare("SELECT * FROM skill_installations ORDER BY bundled DESC, name COLLATE NOCASE").all() as Row[]).map(skillDto);
  }

  async install(sourcePath: string, bundled = false): Promise<SkillDto> {
    const source = resolve(sourcePath);
    if (!(await stat(source)).isDirectory()) throw new Error("Skill source must be a directory");
    const content = await readFile(resolve(source, "SKILL.md"), "utf8");
    const metadata = parseMetadata(content, source.split(sep).at(-1) || "skill");
    const existing = this.list().find((item) => item.id === metadata.id);
    const revision = await hashTree(source);
    const base = resolve(this.store.dataDir, "managed-skills", metadata.id);
    const finalPath = resolve(base, "revisions", revision);
    const staging = resolve(base, `.staging-${randomUUID()}`);
    await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
    try {
      await cp(source, staging, { recursive: true, filter: (path) => !path.split(sep).some((part) => part === ".git" || part === "node_modules") });
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      try { await rename(staging, finalPath); } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      const now = Date.now();
      this.store.sqlite.prepare(`
        INSERT INTO skill_installations (id, name, description, source_path, active_revision, state, error, required_tools_json,
          recommended_approvals_json, bundled, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'loaded', NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
          source_path = excluded.source_path, active_revision = excluded.active_revision, state = 'loaded', error = NULL,
          required_tools_json = excluded.required_tools_json, recommended_approvals_json = excluded.recommended_approvals_json,
          bundled = MAX(skill_installations.bundled, excluded.bundled), updated_at = excluded.updated_at
      `).run(metadata.id, metadata.name, metadata.description, source, revision, JSON.stringify(metadata.requiredTools),
        JSON.stringify(metadata.recommendedApprovals), bundled ? 1 : 0, existing?.installedAt ?? now, now);
      this.store.sqlite.prepare("INSERT OR IGNORE INTO skill_revisions (skill_id, revision, path, created_at) VALUES (?, ?, ?, ?)")
        .run(metadata.id, revision, finalPath, now);
      const skill = this.list().find((item) => item.id === metadata.id)!;
      if (!bundled) this.watchSource(skill.id, source);
      this.events.emit({ type: "skill", skillId: skill.id, state: skill.state });
      return skill;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (existing) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.sqlite.prepare("UPDATE skill_installations SET state = 'error', error = ?, updated_at = ? WHERE id = ?")
          .run(message, Date.now(), metadata.id);
        this.events.emit({ type: "skill", skillId: metadata.id, state: "error", message });
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const skill = this.list().find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    if (skill.bundled) throw new Error("Bundled skills cannot be removed");
    if (this.usedByActiveGeneration(id)) throw new Error("Skill is pinned by an active generation");
    this.watchers.get(id)?.close(); this.watchers.delete(id);
    this.store.sqlite.prepare("DELETE FROM skill_installations WHERE id = ?").run(id);
    await rm(resolve(this.store.dataDir, "managed-skills", id), { recursive: true, force: true });
  }

  activeRevisions(enabledIds: string[]): Record<string, string> {
    const enabled = new Set(enabledIds);
    return Object.fromEntries(this.list().filter((skill) => enabled.has(skill.id) && (skill.state === "loaded" || skill.state === "pending-reload"))
      .map((skill) => [skill.id, skill.revision]));
  }

  async reload(id: string): Promise<SkillDto> {
    const skill = this.list().find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    return this.install(skill.sourcePath, skill.bundled);
  }

  close(): void { this.closed = true; for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); }

  private watchSource(id: string, path: string): void {
    this.watchers.get(id)?.close();
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(path, { recursive: true }, (_event, file) => {
        if (!file || String(file).split(/[\\/]/).some((part) => part === ".git" || part === "node_modules")) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.closed) return;
          this.store.sqlite.prepare("UPDATE skill_installations SET state = 'pending-reload', updated_at = ? WHERE id = ?").run(Date.now(), id);
          this.events.emit({ type: "skill", skillId: id, state: "pending-reload", message: "源文件已更改" });
        }, 250);
      });
      this.watchers.set(id, watcher);
    } catch {}
  }

  tool(record?: GenerationRecord): ServerTool {
    const available = record ? Object.keys(record.agentSnapshot.skillRevisions).length > 0 : this.list().length > 0;
    const selectedIds = record ? new Set(Object.keys(record.agentSnapshot.skillRevisions)) : null;
    const descriptions = this.list().filter((skill) => !selectedIds || selectedIds.has(skill.id))
      .map((skill) => `${skill.id}: ${skill.description}`).join("; ");
    return {
      definition: {
        name: "use_skill", description: `Load an enabled skill or one of its referenced files. ${descriptions}`,
        inputSchema: { type: "object", properties: { id: { type: "string" }, path: { type: "string" } }, required: ["id"] }
      },
      label: "加载 Skill", category: "skill", available, sourceKind: "builtin",
      requiresApproval: () => false,
      execute: async (input) => {
        const id = typeof input.id === "string" ? input.id : typeof input.name === "string" ? input.name : "";
        const revision = record?.agentSnapshot.skillRevisions[id] ?? this.list().find((skill) => skill.id === id)?.revision;
        if (!revision || (record && !record.agentSnapshot.skillRevisions[id])) throw new Error("Skill is not enabled for this Agent snapshot");
        const root = this.revisionPath(id, revision);
        const relative = typeof input.path === "string" && input.path ? input.path : "SKILL.md";
        const target = resolve(root, relative);
        if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Skill path escapes its revision");
        const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(target));
        if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("Skill file resolves outside its revision");
        return readFile(canonical, "utf8");
      }
    };
  }

  private revisionPath(id: string, revision: string): string {
    const row = this.store.sqlite.prepare("SELECT path FROM skill_revisions WHERE skill_id = ? AND revision = ?").get(id, revision) as Row | undefined;
    if (!row) throw new Error("Skill revision not found");
    return String(row.path);
  }

  private usedByActiveGeneration(id: string): boolean {
    const rows = this.store.sqlite.prepare("SELECT agent_snapshot_json FROM generations WHERE status IN ('queued','running','waiting-approval')").all() as Row[];
    return rows.some((row) => {
      try {
        const snapshot = JSON.parse(String(row.agent_snapshot_json ?? "{}")) as { skillRevisions?: Record<string, string> };
        return Boolean(snapshot.skillRevisions?.[id]);
      } catch { return false; }
    });
  }
}

function skillDto(row: Row): SkillDto {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description), revision: String(row.active_revision), sourcePath: String(row.source_path),
    state: row.state as SkillDto["state"], error: row.error === null ? null : String(row.error),
    requiredTools: parseArray(row.required_tools_json), recommendedApprovals: parseApprovals(row.recommended_approvals_json),
    bundled: Boolean(row.bundled), installedAt: Number(row.installed_at), updatedAt: Number(row.updated_at)
  };
}

function parseMetadata(content: string, fallbackId: string): { id: string; name: string; description: string; requiredTools: string[]; recommendedApprovals: Record<string, ApprovalPolicy> } {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const fields = new Map<string, string>();
  for (const line of frontmatter?.[1]?.split("\n") ?? []) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (match) fields.set(match[1]!, match[2]!.trim());
  }
  const id = (fields.get("id") || fallbackId).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
  if (!id) throw new Error("Skill id is invalid");
  const recommendedApprovals: Record<string, ApprovalPolicy> = {};
  for (const pair of (fields.get("recommendedApprovals") ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [tool, policy] = pair.split("=").map((item) => item.trim());
    if (tool && (policy === "default" || policy === "always" || policy === "never")) recommendedApprovals[tool] = policy;
  }
  return {
    id, name: fields.get("name") || id, description: fields.get("description") || "",
    requiredTools: (fields.get("requiredTools") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    recommendedApprovals
  };
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name); hash.update(path.slice(root.length));
      if (entry.isSymbolicLink()) throw new Error("Skill sources cannot contain symbolic links");
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) hash.update(await readFile(path));
    }
  };
  await walk(root); return hash.digest("hex").slice(0, 24);
}

function parseArray(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
function parseApprovals(value: unknown): Record<string, ApprovalPolicy> { try { return JSON.parse(String(value)) as Record<string, ApprovalPolicy>; } catch { return {}; } }
