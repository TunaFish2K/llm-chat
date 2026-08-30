import type { ToolCatalogItemDto } from "@llm-chat/contracts";
import type { GenerationRecord, Store } from "./database";
import type { TaskManager } from "./background-tasks";
import type { PluginManager } from "./plugins";
import type { SkillManager } from "./skills";
import { buildServerTools, type ServerTool } from "./tools";
import { isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class ToolRegistry {
  constructor(
    private readonly store: Store,
    private readonly tasks: TaskManager,
    private readonly plugins: PluginManager,
    private readonly skills: SkillManager
  ) {}

  async tools(record?: GenerationRecord, includeUnavailable = false): Promise<ServerTool[]> {
    if (record && record.agentSnapshot.extensionsPinned !== true) {
      record.agentSnapshot.toolRevisions = this.plugins.activeRevisions();
      record.agentSnapshot.skillRevisions = this.skills.activeRevisions(record.agentSnapshot.execution.enabledSkillIds);
      record.agentSnapshot.extensionsPinned = true;
      this.store.updateGenerationExtensionSnapshot(record.id, record.agentSnapshot);
    }
    const builtins = (await buildServerTools(this.store, true, {
      taskManager: this.tasks,
      ...(record ? { workspacePath: record.agentSnapshot.workspacePath } : {})
    })).filter((tool) => tool.definition.name !== "use_skill");
    const all = [...builtins, this.skills.tool(record), ...this.managementTools(), ...await this.plugins.tools(record)];
    const policy = record?.agentSnapshot.execution.tools;
    return all.filter((tool) => (includeUnavailable || tool.available)
      && (!policy || (policy.overrides[tool.definition.name] ?? policy.defaultEnabled)));
  }

  async catalog(): Promise<ToolCatalogItemDto[]> {
    const entries = await this.tools(undefined, true);
    return Promise.all(entries.map(async (entry): Promise<ToolCatalogItemDto> => ({
      name: entry.definition.name, label: entry.label, description: entry.definition.description,
      category: entry.category, requiresApproval: await entry.requiresApproval({}), available: entry.available,
      approvalMode: "dynamic", sourceKind: entry.sourceKind ?? (entry.category === "mcp" ? "mcp" : "builtin"),
      ...(entry.sourceId ? { sourceId: entry.sourceId } : {}), ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
      ...(entry.revision ? { revision: entry.revision } : {})
    })));
  }

  close(): void { this.plugins.close(); this.skills.close(); }

  private managementTools(): ServerTool[] {
    const definition = (name: string, description: string, properties: Record<string, unknown>, execute: ServerTool["execute"]): ServerTool => ({
      definition: { name, description, inputSchema: { type: "object", properties, required: name.includes("install") ? ["source_path"] : [name.startsWith("plugin_") ? "plugin_id" : "source_path"] } },
      label: name, category: "plugin", available: true, sourceKind: "builtin", requiresApproval: () => true, execute
    });
    const source = async (input: Record<string, unknown>, workspacePath: string | null): Promise<string> => {
      if (!workspacePath) throw new Error("Conversation has no workspace");
      const value = typeof input.source_path === "string" ? input.source_path : "";
      if (!value) throw new Error("source_path is required");
      const path = isAbsolute(value) ? resolve(value) : resolve(workspacePath, value);
      const canonical = await realpath(path);
      if (canonical !== workspacePath && !canonical.startsWith(`${workspacePath}${sep}`)) throw new Error("Plugin or skill source must be inside the conversation workspace");
      return canonical;
    };
    return [
      definition("plugin_install", "Install or update an ESM tool plugin from a directory in the conversation workspace.", { source_path: { type: "string" } },
        async (input, _signal, context) => JSON.stringify(await this.plugins.install(await source(input, context?.snapshot.workspacePath ?? null)))),
      definition("plugin_reload", "Reload the active managed plugin revision.", { plugin_id: { type: "string" } },
        async (input) => JSON.stringify(await this.plugins.reload(required(input, "plugin_id")))),
      definition("plugin_unload", "Unload a managed plugin for new generations.", { plugin_id: { type: "string" } },
        async (input) => JSON.stringify(this.plugins.unload(required(input, "plugin_id")))),
      definition("plugin_remove", "Remove a managed plugin and its revisions.", { plugin_id: { type: "string" } },
        async (input) => { await this.plugins.remove(required(input, "plugin_id")); return JSON.stringify({ success: true }); }),
      definition("skill_install", "Install or update a Skill from a directory in the conversation workspace.", { source_path: { type: "string" } },
        async (input, _signal, context) => JSON.stringify(await this.skills.install(await source(input, context?.snapshot.workspacePath ?? null)))),
      definition("skill_reload", "Reload a Skill source directory from the conversation workspace.", { source_path: { type: "string" } },
        async (input, _signal, context) => JSON.stringify(await this.skills.install(await source(input, context?.snapshot.workspacePath ?? null))))
    ];
  }
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}
