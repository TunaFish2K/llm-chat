import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  agentInputSchema,
  appSettingsSchema,
  connectionInputSchema,
  conversationExecutionOverridesSchema,
  mcpServerInputSchema,
  mcpServerPatchSchema,
  modelInputSchema,
  patchConversationSchema,
  toolSettingsInputSchema,
  type FileAssetDto,
  type ModelDto
} from "@llm-chat/contracts";
import { adapterFor } from "@llm-chat/providers";
import type { TaskManager } from "./background-tasks";
import { BalanceService } from "./balance";
import { exportCharacterCard, importCharacterCard } from "./character-card";
import type { Store } from "./database";
import { StoreError } from "./database";
import type { EventHub } from "./events";
import { sniffImage, type ImageService } from "./images";
import { mcpManager } from "./mcp";
import { ModelCatalogService } from "./model-catalog";
import type { PluginManager } from "./plugins";
import type { SkillManager } from "./skills";
import type { ServerTool, ToolExecutionContext } from "./tools";

type JsonObject = Record<string, unknown>;
type Resource = "agents" | "conversations" | "settings" | "connections" | "models" | "mcp" | "skills" | "plugins" | "tools";

const READ_ACTIONS = new Set(["list", "get", "test", "balance"]);

export interface AppToolDependencies {
  store: Store;
  tasks: TaskManager;
  plugins: PluginManager;
  skills: SkillManager;
  files: ImageService;
  events: EventHub;
  balance: BalanceService;
  catalog: ModelCatalogService;
}

/** Type-scoped application administration tools. Secret material is deliberately absent. */
export class AppTools {
  constructor(private readonly deps: AppToolDependencies) {}

  tools(): ServerTool[] {
    return [
      this.tool("app_agents", "Agent 管理", "List, inspect, create, update, import, export, set avatar, or delete llm-chat Agents. Character-card sources may be a current-conversation attachment, public URL, or selected workspace file.",
        ["list", "get", "create", "update", "import", "export", "set_avatar", "remove_avatar", "delete"], (input, signal, context) => this.agents(input, signal, context)),
      this.tool("app_conversations", "会话管理", "List, inspect, create, update, delete, fork without generation, or select an existing response version. This tool never starts model generation or context summarization.",
        ["list", "get", "create", "update", "delete", "fork", "select_generation"], (input, _signal, context) => this.conversations(input, context)),
      this.tool("app_settings", "应用设置", "Read or update non-secret llm-chat settings. Login credentials are never available.",
        ["get", "update"], (input) => this.settings(input)),
      this.tool("app_connections", "连接管理", "Manage non-secret connection fields, test a connection, query balance, or discover models. API keys and secret headers cannot be read or written.",
        ["list", "get", "create", "update", "test", "balance", "discover_models", "delete"], (input, signal) => this.connections(input, signal)),
      this.tool("app_models", "模型管理", "List, inspect, create, update, restore catalog defaults, or delete models.",
        ["list", "get", "create", "update", "restore_catalog", "delete"], (input) => this.models(input)),
      this.tool("app_mcp_servers", "MCP 管理", "Manage and test MCP server definitions without exposing or changing secret headers.",
        ["list", "get", "create", "update", "test", "delete"], (input) => this.mcp(input)),
      this.tool("app_skills", "Skill 管理", "List, discover, install, or reload Skills. Skill removal is intentionally unavailable because sources may be externally managed.",
        ["list", "discover", "install", "reload"], (input, _signal, context) => this.skills(input, context)),
      this.tool("app_plugins", "Plugin 管理", "List, install, configure non-secret fields, reload, unload, or remove managed plugins.",
        ["list", "install", "configure", "reload", "unload", "delete"], (input, _signal, context) => this.plugins(input, context)),
      this.tool("app_tool_settings", "工具设置", "Read or update global tool enablement, search URL, and workspace Shell state. Search API keys are never available.",
        ["get", "update"], (input) => this.toolSettings(input))
    ];
  }

  private tool(name: string, label: string, description: string, actions: string[], execute: ServerTool["execute"]): ServerTool {
    return {
      definition: {
        name,
        description,
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: actions },
            id: { type: "string", description: "Target resource UUID or stable ID" },
            input: { type: "object", description: "Typed create or update fields" },
            source: { type: "string", enum: ["attachment", "url", "workspace"] },
            asset_id: { type: "string" },
            url: { type: "string" },
            path: { type: "string" },
            workspace: { type: "string", enum: ["project", "attachments"], default: "attachments" },
            format: { type: "string", enum: ["json", "png"] },
            through_message_id: { type: ["string", "null"] },
            message_id: { type: "string" },
            generation_id: { type: "string" },
            refresh: { type: "boolean" }
          },
          required: ["action"],
          additionalProperties: false
        }
      },
      label,
      category: "app",
      available: true,
      sourceKind: "builtin",
      requiresApproval: (input) => {
        const action = typeof input.action === "string" ? input.action.trim() : "";
        return !READ_ACTIONS.has(action);
      },
      execute
    };
  }

  private async agents(input: JsonObject, signal: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.store.listAgents());
    if (action === "get") return json(requiredResource(this.deps.store.getAgent(id(input)), "agent_not_found", "Agent 不存在"));
    if (action === "create") return this.changed("agents", this.deps.store.createAgent(agentInputSchema.parse(object(input))));
    if (action === "update") {
      const agent = this.deps.store.updateAgent(id(input), agentInputSchema.partial().parse(object(input)));
      if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
      this.deps.tasks.notifyAgentPolicyChanged(agent.id);
      return this.changed("agents", agent, agent.id);
    }
    if (action === "import") {
      const source = await this.cardSource(input, signal, context);
      return this.changed("agents", importCharacterCard(this.deps.store, source.fileName, source.bytes));
    }
    if (action === "export") {
      requireContext(context);
      const agent = requiredResource(this.deps.store.getAgent(id(input)), "agent_not_found", "Agent 不存在");
      const exported = exportCharacterCard(this.deps.store, agent, input.format === "png" ? "png" : "json");
      const asset = await this.deps.files.importFile(exported.fileName, exported.contentType, exported.bytes);
      this.deps.store.attachFileToToolCall(context!.toolCallId, asset.id);
      return this.changed("agents", { asset, markdown: fileMarkdown(asset) }, agent.id);
    }
    if (action === "set_avatar") {
      const loaded = await this.sourceFile(input, signal, context);
      if (loaded.bytes.byteLength > 10 * 1024 * 1024 || sniffImage(loaded.bytes) !== "image/png") {
        throw new StoreError("agent_avatar_invalid", "头像必须是小于 10 MiB 的 PNG");
      }
      const agent = this.deps.store.setAgentAvatar(id(input), loaded.bytes);
      if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
      return this.changed("agents", agent, agent.id);
    }
    if (action === "remove_avatar") {
      const agent = this.deps.store.setAgentAvatar(id(input), null);
      if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
      return this.changed("agents", agent, agent.id);
    }
    if (action === "delete") {
      if (this.deps.tasks.hasNonterminalForAgent(id(input))) throw new StoreError("agent_busy", "Agent 仍有后台任务");
      if (!this.deps.store.deleteAgent(id(input))) throw new StoreError("agent_not_found", "Agent 不存在");
      return this.changed("agents", { success: true }, id(input));
    }
    throw invalidAction(action);
  }

  private async conversations(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.store.listConversations());
    if (action === "get") return json({
      conversation: requiredResource(this.deps.store.getConversation(id(input)), "conversation_not_found", "会话不存在"),
      messages: this.deps.store.listMessages(id(input))
    });
    if (action === "create") {
      const value = object(input);
      const agentId = string(value, "agentId");
      const conversation = this.deps.store.createConversation({
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        agentId,
        executionOverrides: conversationExecutionOverridesSchema.parse(value.executionOverrides ?? {}),
        workspacePath: null
      });
      return this.changed("conversations", conversation, conversation.id);
    }
    if (action === "update") {
      const value = object(input);
      if (Object.hasOwn(value, "workspacePath")) throw new StoreError("app_workspace_path_forbidden", "网站管理工具不能绑定任意宿主机路径");
      const conversation = this.deps.store.updateConversation(id(input), patchConversationSchema.parse(value));
      if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
      return this.changed("conversations", conversation, conversation.id);
    }
    if (action === "delete") {
      const target = id(input);
      if (context?.conversationId === target) throw new StoreError("conversation_busy", "不能从当前生成删除当前会话");
      if (this.deps.store.isConversationBusy(target) || this.deps.tasks.hasNonterminalForConversation(target)) {
        throw new StoreError("conversation_busy", "会话仍有生成或后台任务");
      }
      if (!this.deps.store.deleteConversation(target)) throw new StoreError("conversation_not_found", "会话不存在");
      await this.deps.files.scheduleAttachmentWorkspaceCleanup(target);
      return this.changed("conversations", { success: true }, target);
    }
    if (action === "fork") {
      const target = id(input);
      const fork = this.deps.store.forkConversation(target, {
        mode: "continue",
        throughMessageId: nullableString(input.through_message_id)
      });
      await this.deps.files.cloneAttachmentWorkspace(target, fork.conversation.id);
      return this.changed("conversations", fork, fork.conversation.id);
    }
    if (action === "select_generation") {
      const messageId = string(input, "message_id");
      if (!this.deps.store.selectGeneration(messageId, string(input, "generation_id"))) {
        throw new StoreError("generation_not_found", "回复版本不存在");
      }
      return this.changed("conversations", { success: true, messageId }, this.deps.store.conversationIdForMessage(messageId));
    }
    throw invalidAction(action);
  }

  private async settings(input: JsonObject): Promise<string> {
    const action = string(input, "action");
    if (action === "get") return json(this.deps.store.getSettings());
    if (action === "update") {
      const patch = appSettingsSchema.partial().parse(object(input));
      if (patch.defaultModelId) {
        const model = this.deps.store.getModel(patch.defaultModelId);
        if (!model) throw new StoreError("model_not_found", "默认模型不存在");
        if (!model.enabled) throw new StoreError("model_disabled", "默认模型已停用");
      }
      for (const agentId of [patch.defaultAgentId, patch.lastAgentId]) {
        if (agentId && !this.deps.store.getAgent(agentId)) throw new StoreError("agent_not_found", "Agent 不存在");
      }
      return this.changed("settings", this.deps.store.updateSettings(patch));
    }
    throw invalidAction(action);
  }

  private async connections(input: JsonObject, signal: AbortSignal): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.store.listConnections());
    if (action === "get") return json(requiredResource(this.deps.store.listConnections().find((item) => item.id === id(input)), "connection_not_found", "连接不存在"));
    if (action === "create" || action === "update") assertNoSecrets(object(input));
    if (action === "create") {
      const value = connectionInputSchema.parse({ ...object(input), secretHeaders: {}, apiKey: undefined });
      return this.changed("connections", this.deps.store.createConnection(value));
    }
    if (action === "update") {
      const value = connectionInputSchema.partial().parse(object(input));
      const connection = this.deps.store.updateConnection(id(input), value);
      if (!connection) throw new StoreError("connection_not_found", "连接不存在");
      return this.changed("connections", connection, connection.id);
    }
    const connection = requiredResource(this.deps.store.getConnection(id(input)), "connection_not_found", "连接不存在");
    if (action === "test") {
      const models = await adapterFor(connection.protocol).listModels(connection, signal);
      return json({ ok: true, modelsFound: models.length });
    }
    if (action === "balance") return json(await this.deps.balance.get(connection, input.refresh === true));
    if (action === "discover_models") {
      const discovered = await adapterFor(connection.protocol).listModels(connection, signal);
      const enrichment = await this.deps.catalog.enrich(connection, discovered);
      const changed: ModelDto[] = [];
      for (const item of enrichment.models) changed.push(this.deps.store.upsertDiscoveredModel(item.input, item.catalogMetadata).model);
      return this.changed("models", { discovered: discovered.length, models: changed, warning: enrichment.warning ?? null });
    }
    if (action === "delete") {
      if (!this.deps.store.deleteConnection(connection.id)) throw new StoreError("connection_not_found", "连接不存在");
      return this.changed("connections", { success: true }, connection.id);
    }
    throw invalidAction(action);
  }

  private async models(input: JsonObject): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.store.listModels(typeof input.id === "string" ? input.id : undefined));
    if (action === "get") return json(requiredResource(this.deps.store.getModel(id(input)), "model_not_found", "模型不存在"));
    if (action === "create") {
      const value = modelInputSchema.parse(object(input));
      if (!this.deps.store.getConnection(value.connectionId)) throw new StoreError("connection_not_found", "连接不存在");
      return this.changed("models", this.deps.store.createModel(value));
    }
    if (action === "update") {
      const value = modelInputSchema.partial().parse(object(input));
      if (value.connectionId && !this.deps.store.getConnection(value.connectionId)) {
        throw new StoreError("connection_not_found", "连接不存在");
      }
      const model = this.deps.store.updateModel(id(input), value);
      if (!model) throw new StoreError("model_not_found", "模型不存在");
      return this.changed("models", model, model.id);
    }
    if (action === "restore_catalog") {
      const model = requiredResource(this.deps.store.getModel(id(input)), "model_not_found", "模型不存在");
      const connection = requiredResource(this.deps.store.getConnection(model.connectionId), "connection_not_found", "连接不存在");
      const enriched = await this.deps.catalog.enrichOne(connection, model.modelKey, model.modelKey);
      if (!enriched?.catalogMetadata) throw new StoreError("model_catalog_match_not_found", "模型目录中没有可信匹配");
      return this.changed("models", this.deps.store.restoreCatalogModel(model.id, enriched.input, enriched.catalogMetadata), model.id);
    }
    if (action === "delete") {
      if (!this.deps.store.deleteModel(id(input))) throw new StoreError("model_not_found", "模型不存在");
      return this.changed("models", { success: true }, id(input));
    }
    throw invalidAction(action);
  }

  private async mcp(input: JsonObject): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.store.listMcpServers());
    if (action === "get") return json(requiredResource(this.deps.store.listMcpServers().find((item) => item.id === id(input)), "mcp_server_not_found", "MCP 服务不存在"));
    if (action === "create" || action === "update") assertNoHeaders(object(input));
    if (action === "create") return this.changed("mcp", this.deps.store.createMcpServer(mcpServerInputSchema.parse({ ...object(input), headers: {} })));
    if (action === "update") {
      const server = this.deps.store.updateMcpServer(id(input), mcpServerPatchSchema.parse(object(input)));
      if (!server) throw new StoreError("mcp_server_not_found", "MCP 服务不存在");
      mcpManager(this.deps.store).invalidate(server.id);
      return this.changed("mcp", server, server.id);
    }
    if (action === "test") return json(await mcpManager(this.deps.store).test(id(input)));
    if (action === "delete") {
      mcpManager(this.deps.store).invalidate(id(input));
      if (!this.deps.store.deleteMcpServer(id(input))) throw new StoreError("mcp_server_not_found", "MCP 服务不存在");
      return this.changed("mcp", { success: true }, id(input));
    }
    throw invalidAction(action);
  }

  private async skills(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.skills.list());
    if (action === "discover") return this.changed("skills", await this.deps.skills.discover());
    if (action === "install") return this.changed("skills", await this.deps.skills.install(await this.workspaceSource(input, context)));
    if (action === "reload") return this.changed("skills", await this.deps.skills.reload(id(input)), id(input));
    throw invalidAction(action);
  }

  private async plugins(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    const action = string(input, "action");
    if (action === "list") return json(this.deps.plugins.list());
    if (action === "install") return this.changed("plugins", await this.deps.plugins.install(await this.workspaceSource(input, context)));
    if (action === "configure") return this.changed("plugins", this.deps.plugins.configurePublic(id(input), object(input)), id(input));
    if (action === "reload") return this.changed("plugins", await this.deps.plugins.reload(id(input)), id(input));
    if (action === "unload") return this.changed("plugins", this.deps.plugins.unload(id(input)), id(input));
    if (action === "delete") {
      await this.deps.plugins.remove(id(input));
      return this.changed("plugins", { success: true }, id(input));
    }
    throw invalidAction(action);
  }

  private async toolSettings(input: JsonObject): Promise<string> {
    const action = string(input, "action");
    if (action === "get") return json(this.deps.store.getToolSettings());
    if (action === "update") {
      const value = object(input);
      if (value.search && typeof value.search === "object" && Object.hasOwn(value.search, "apiKey")) {
        throw new StoreError("secret_field_forbidden", "网站管理工具不能修改搜索 API Key");
      }
      const parsed = toolSettingsInputSchema.parse(value);
      return this.changed("tools", this.deps.store.updateToolSettings(parsed));
    }
    throw invalidAction(action);
  }

  private async cardSource(input: JsonObject, signal: AbortSignal, context?: ToolExecutionContext) {
    return this.sourceFile(input, signal, context);
  }

  private async sourceFile(input: JsonObject, signal: AbortSignal, context?: ToolExecutionContext): Promise<{ bytes: Uint8Array; fileName: string }> {
    const source = string(input, "source");
    if (source === "attachment") {
      requireContext(context);
      const assetId = string(input, "asset_id");
      const owned = this.deps.store.sqlite.prepare(`
        SELECT 1 FROM message_file_assets f JOIN messages m ON m.id = f.message_id
        WHERE f.asset_id = ? AND m.conversation_id = ? LIMIT 1
      `).get(assetId, context!.conversationId);
      if (!owned) throw new StoreError("file_asset_not_found", "当前会话没有该附件");
      const loaded = await this.deps.files.readFileAsset(assetId);
      return { bytes: loaded.bytes, fileName: loaded.asset.fileName };
    }
    if (source === "url") return this.deps.files.fetchPublicFile(string(input, "url"), 10 * 1024 * 1024, signal);
    if (source === "workspace") {
      const path = await this.workspaceSource(input, context);
      const info = await stat(path);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new StoreError("card_too_large", "文件必须小于 10 MiB");
      return { bytes: new Uint8Array(await readFile(path)), fileName: path.split(sep).at(-1) || "file" };
    }
    throw new StoreError("file_source_invalid", "source 必须是 attachment、url 或 workspace");
  }

  private async workspaceSource(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    requireContext(context);
    const root = input.workspace === "project"
      ? context!.snapshot.workspacePath
      : this.deps.files.attachmentWorkspace(context!.conversationId);
    if (!root) throw new StoreError("workspace_required", "当前会话没有项目工作区");
    const value = string(input, "path");
    if (isAbsolute(value)) throw new StoreError("workspace_path_invalid", "路径必须相对工作区");
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(resolve(root, value));
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new StoreError("workspace_path_invalid", "路径越过了工作区边界");
    }
    return canonical;
  }

  private changed(resource: Resource, value: unknown, resourceId?: string): string {
    this.deps.events.emit({ type: "resource-changed", resource, ...(resourceId ? { resourceId } : {}) });
    return json(value);
  }
}

function string(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new StoreError("app_tool_input_invalid", `${key} is required`);
  return value.trim();
}
function id(input: JsonObject): string { return string(input, "id"); }
function object(input: JsonObject): JsonObject {
  const value = input.input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("app_tool_input_invalid", "input object is required");
  return value as JsonObject;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function json(value: unknown): string { return JSON.stringify(value); }
function requiredResource<T>(value: T | undefined, code: string, message: string): T {
  if (value === undefined) throw new StoreError(code, message);
  return value;
}
function requireContext(context?: ToolExecutionContext): asserts context is ToolExecutionContext {
  if (!context) throw new StoreError("tool_context_required", "该操作需要会话上下文");
}
function assertNoSecrets(input: JsonObject): void {
  if (Object.hasOwn(input, "apiKey") || Object.hasOwn(input, "secretHeaders")) {
    throw new StoreError("secret_field_forbidden", "网站管理工具不能读取或修改连接密钥");
  }
}
function assertNoHeaders(input: JsonObject): void {
  if (Object.hasOwn(input, "headers")) throw new StoreError("secret_field_forbidden", "网站管理工具不能读取或修改 MCP 请求头");
}
function invalidAction(action: string): StoreError { return new StoreError("app_tool_action_invalid", `不支持的操作：${action}`); }
function fileMarkdown(asset: FileAssetDto): string {
  const label = asset.fileName.replace(/[\[\]]/g, "") || "file";
  return asset.kind === "image" ? `![${label}](${asset.url})` : `[${label}](${asset.url})`;
}
