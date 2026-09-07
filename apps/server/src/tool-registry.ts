import type { AgentSearchConfig, ToolCatalogItemDto } from "@llm-chat/contracts";
import type { GenerationRecord, Store } from "./database";
import type { TaskManager } from "./background-tasks";
import type { PluginManager } from "./plugins";
import type { SkillManager } from "./skills";
import { buildServerTools, type ServerTool } from "./tools";
import { isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { ImageService } from "./images";
import type { AppTools } from "./app-tools";
import type { ImageGenerationManager } from "./image-generation";
import type { CodexManager } from "./codex";

export const SEARCH_TOOLS_NAME = "search_tools";

export interface ToolSearchSummary {
  name: string;
  label: string;
  description: string;
  category: ServerTool["category"];
  arguments: string[];
}

export interface ToolSearchResult {
  query: string;
  loadedToolNames: string[];
  tools: ToolSearchSummary[];
}

export function createSearchToolsTool(lazyTools: ServerTool[]): ServerTool {
  return {
    definition: {
      name: SEARCH_TOOLS_NAME,
      description: "Search the authorized lazy tool catalog. Matching tools are loaded for later model steps in this generation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500, description: "Tool capability to find" },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Maximum matching tools" }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    label: "搜索工具",
    category: "local",
    available: true,
    sourceKind: "builtin",
    requiresApproval: () => false,
    activatesTools: (input) => {
      const { query, limit } = searchInput(input);
      return searchTools(lazyTools, query, limit).loadedToolNames;
    },
    execute: async (input) => {
      const { query, limit } = searchInput(input);
      return JSON.stringify(searchTools(lazyTools, query, limit));
    }
  };
}

export function searchTools(tools: ServerTool[], query: string, limit = 5): ToolSearchResult {
  const terms = normalizedTerms(query);
  const ranked = tools.map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.tool.definition.name.localeCompare(right.tool.definition.name, "en"))
    .slice(0, Math.min(10, Math.max(1, Math.floor(limit))));
  const summaries = ranked.map(({ tool }): ToolSearchSummary => ({
    name: tool.definition.name,
    label: tool.label,
    description: tool.definition.description,
    category: tool.category,
    arguments: schemaPropertyNames(tool.definition.inputSchema)
  }));
  return { query, loadedToolNames: summaries.map((tool) => tool.name), tools: summaries };
}

export class ToolRegistry {
  constructor(
    private readonly store: Store,
    private readonly tasks: TaskManager,
    private readonly plugins: PluginManager,
    private readonly skills: SkillManager,
    private readonly images?: ImageService,
    private readonly appTools?: AppTools,
    private readonly imageJobs?: ImageGenerationManager,
    private readonly codex?: CodexManager
  ) {}

  async tools(
    record?: GenerationRecord,
    includeUnavailable = false,
    search?: { searchConfig?: AgentSearchConfig; searchApiKey?: string }
  ): Promise<ServerTool[]> {
    if (record && record.agentSnapshot.extensionsPinned !== true) {
      record.agentSnapshot.toolRevisions = this.plugins.activeRevisions();
      record.agentSnapshot.skillRevisions = this.skills.activeRevisions(record.agentSnapshot.execution.enabledSkillIds);
      record.agentSnapshot.extensionsPinned = true;
      this.store.updateGenerationExtensionSnapshot(record.id, record.agentSnapshot);
    }
    const builtins = (await buildServerTools(this.store, true, {
      taskManager: this.tasks,
      ...(this.images ? { imageService: this.images } : {}),
      ...(this.imageJobs ? { imageManager: this.imageJobs } : {}),
      ...(this.codex ? { codexManager: this.codex } : {}),
      ...(record ? {
        workspacePath: record.agentSnapshot.workspacePath,
        attachmentWorkspacePath: resolve(this.store.dataDir, "attachment-workspaces", record.conversationId),
        searchConfig: record.agentSnapshot.execution.search,
        searchApiKey: record.agentSnapshot.agentId
          ? this.store.getAgentSearchSecret(record.agentSnapshot.agentId, record.agentSnapshot.execution.search.provider)
          : ""
      } : search ?? {})
    })).filter((tool) => tool.definition.name !== "use_skill");
    const management = this.appTools ? this.appTools.tools() : this.managementTools();
    const all = [...builtins, this.skills.tool(record), ...management, ...await this.plugins.tools(record)];
    const policy = record?.agentSnapshot.execution.tools;
    return all.filter((tool) => (includeUnavailable || tool.available)
      && (!policy || (policy.overrides[tool.definition.name] ?? policy.defaultEnabled)));
  }

  async catalog(agentId?: string): Promise<ToolCatalogItemDto[]> {
    const agent = agentId ? this.store.getAgent(agentId) : undefined;
    const entries = await this.tools(undefined, true, agent ? {
      searchConfig: agent.execution.search,
      searchApiKey: this.store.getAgentSearchSecret(agent.id, agent.execution.search.provider)
    } : undefined);
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

function searchInput(input: Record<string, unknown>): { query: string; limit: number } {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 500) throw new Error("query must be 1 to 500 characters");
  const limit = input.limit === undefined ? 5 : input.limit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10) {
    throw new Error("limit must be an integer from 1 to 10");
  }
  return { query, limit: Number(limit) };
}

function scoreTool(tool: ServerTool, terms: string[]): number {
  if (!terms.length) return 0;
  const fields = [
    { value: tool.definition.name, weight: 8 },
    { value: tool.label, weight: 6 },
    { value: tool.category, weight: 4 },
    ...schemaPropertyNames(tool.definition.inputSchema).map((value) => ({ value, weight: 5 })),
    { value: tool.definition.description, weight: 2 }
  ].map((field) => ({ ...field, normalized: normalizeSearchText(field.value), tokens: normalizedTerms(field.value) }));
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      const match = field.normalized === term
        ? 400
        : field.tokens.includes(term)
          ? 200
          : field.tokens.some((token) => token.startsWith(term))
            ? 100
            : field.tokens.some((token) => token.includes(term))
              ? 40
              : field.normalized.includes(term) ? 10 : 0;
      best = Math.max(best, match * field.weight);
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizedTerms(value: string): string[] {
  return [...new Set(normalizeSearchText(value).split(/\s+/).filter(Boolean))];
}

function schemaPropertyNames(schema: unknown): string[] {
  const result = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    if (object.properties && typeof object.properties === "object" && !Array.isArray(object.properties)) {
      for (const [name, property] of Object.entries(object.properties as Record<string, unknown>)) {
        result.add(name);
        visit(property);
      }
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf"] as const) {
      const nested = object[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else visit(nested);
    }
  };
  visit(schema);
  return [...result].sort((left, right) => left.localeCompare(right, "en"));
}
