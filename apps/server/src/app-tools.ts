import { withMessage } from "@llm-chat/i18n";
import type { ConversationService } from "./conversations";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  agentInputSchema,
  agentRoleplayConfigSchema,
  appSettingsUpdateSchema,
  connectionInputSchema,
  connectionInputPatchSchema,
  conversationExecutionOverridesSchema,
  conversationRoleplayStatePatchSchema,
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
import { exportCharacterCardWithAssets, importCharacterCardWithAssets } from "./character-card";
import type { Store } from "./database";
import { StoreError } from "./errors";
import type { EventHub } from "./events";
import { sniffImage, type ImageService } from "./images";
import { mcpManager } from "./mcp";
import { ModelCatalogService } from "./model-catalog";
import type { PluginManager } from "./plugins";
import type { SkillManager } from "./skills";
import type { ServerTool, ToolExecutionContext } from "./tools";
import { executeRestrictedStscript } from "./stscript";
import { providerRequestContextForConversation } from "./provider-context";

type JsonObject = Record<string, unknown>;
type Resource = "agents" | "conversations" | "settings" | "connections" | "models" | "mcp" | "skills" | "plugins" | "tools";

const READ_ACTIONS = new Set(["list", "get", "test", "balance", "get_agent", "get_state", "audit"]);

export interface AppToolDependencies {
  store: Store;
  conversations: Pick<ConversationService, "fork">;
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
      this.tool("app_conversations", "会话管理", "List, inspect, create, update, fork without generation, or select an existing response version. This tool never starts model generation or context summarization.",
        ["list", "get", "create", "update", "fork", "select_generation"], (input) => this.conversations(input)),
      this.tool("app_settings", "应用设置", "Read or update non-secret llm-chat settings. Generation settings belong to app_agents execution, including baseSystemPrompt. Login credentials are never available.",
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
      this.tool("app_tool_settings", "工具设置", "Read or update global tool enablement and workspace Shell state. Search settings belong to each Agent.",
        ["get", "update"], (input) => this.toolSettings(input)),
      this.tool("app_roleplay", "角色工作流", "Inspect or update Agent-owned roleplay configuration and conversation roleplay state, run restricted STscript, or inspect its audit log. No arbitrary JavaScript, shell, or network execution is available.",
        ["get_agent", "update_agent", "get_state", "update_state", "run_script", "audit"], (input, _signal, context) => this.roleplay(input, context))
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
            format: { type: "string", enum: ["json", "png", "charx"] },
            through_message_id: { type: ["string", "null"] },
            message_id: { type: "string" },
            generation_id: { type: "string" },
            refresh: { type: "boolean" },
            script: { type: "string", maxLength: 500000 },
            draft: { type: "string", maxLength: 1000000 }
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
      if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
      this.deps.tasks.notifyAgentPolicyChanged(agent.id);
      return this.changed("agents", agent, agent.id);
    }
    if (action === "import") {
      const source = await this.cardSource(input, signal, context);
      return this.changed("agents", await importCharacterCardWithAssets(
        this.deps.store, this.deps.files, source.fileName, source.bytes
      ));
    }
    if (action === "export") {
      requireContext(context);
      const agent = requiredResource(this.deps.store.getAgent(id(input)), "agent_not_found", "Agent 不存在");
      const format = input.format === "png" || input.format === "charx" ? input.format : "json";
      const exported = await exportCharacterCardWithAssets(this.deps.store, this.deps.files, agent, format);
      const asset = await this.deps.files.importFile(exported.fileName, exported.contentType, exported.bytes);
      this.deps.store.attachFileToToolCall(context!.toolCallId, asset.id);
      return this.changed("agents", { asset, markdown: fileMarkdown(asset) }, agent.id);
    }
    if (action === "set_avatar") {
      const loaded = await this.sourceFile(input, signal, context);
      if (loaded.bytes.byteLength > 10 * 1024 * 1024 || sniffImage(loaded.bytes) !== "image/png") {
        throw withMessage(new StoreError("agent_avatar_invalid", "头像必须是小于 10 MiB 的 PNG"), "error.the_avatar_must_be_a_png_smaller_than_10_mib");
      }
      const agent = this.deps.store.setAgentAvatar(id(input), loaded.bytes);
      if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
      return this.changed("agents", agent, agent.id);
    }
    if (action === "remove_avatar") {
      const agent = this.deps.store.setAgentAvatar(id(input), null);
      if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
      return this.changed("agents", agent, agent.id);
    }
    if (action === "delete") {
      if (this.deps.tasks.hasNonterminalForAgent(id(input))) throw withMessage(new StoreError("agent_busy", "Agent 仍有后台任务"), "error.the_agent_still_has_background_tasks");
      if (!this.deps.store.deleteAgent(id(input))) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
      return this.changed("agents", { success: true }, id(input));
    }
    throw invalidAction(action);
  }

  private async conversations(input: JsonObject): Promise<string> {
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
      if (Object.hasOwn(value, "workspacePath")) throw withMessage(new StoreError("app_workspace_path_forbidden", "网站管理工具不能绑定任意宿主机路径"), "error.app_management_tools_cannot_bind_arbitrary_host_paths");
      const conversation = this.deps.store.updateConversation(id(input), patchConversationSchema.parse(value));
      if (!conversation) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
      return this.changed("conversations", conversation, conversation.id);
    }
    if (action === "fork") {
      const target = id(input);
      const fork = await this.deps.conversations.fork(target, {
        mode: "continue",
        throughMessageId: nullableString(input.through_message_id)
      });
      return this.changed("conversations", fork, fork.conversation.id);
    }
    if (action === "select_generation") {
      const messageId = string(input, "message_id");
      if (!this.deps.store.selectGeneration(messageId, string(input, "generation_id"))) {
        throw withMessage(new StoreError("generation_not_found", "回复版本不存在"), "error.reply_version_not_found");
      }
      return this.changed("conversations", { success: true, messageId }, this.deps.store.conversationIdForMessage(messageId));
    }
    throw invalidAction(action);
  }

  private async settings(input: JsonObject): Promise<string> {
    const action = string(input, "action");
    if (action === "get") return json(this.deps.store.getSettings());
    if (action === "update") {
      const patch = appSettingsUpdateSchema.parse(object(input));
      for (const agentId of [patch.defaultAgentId, patch.lastAgentId]) {
        if (agentId && !this.deps.store.getAgent(agentId)) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
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
      const value = connectionInputPatchSchema.parse(object(input));
      const connection = this.deps.store.updateConnection(id(input), value);
      if (!connection) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
      return this.changed("connections", connection, connection.id);
    }
    const connection = requiredResource(this.deps.store.getConnection(id(input)), "connection_not_found", "连接不存在");
    if (action === "test") {
      const models = await adapterFor(connection.protocol).listModels(
        connection,
        signal,
        providerRequestContextForConversation(connection.id, "models")
      );
      return json({ ok: true, modelsFound: models.length });
    }
    if (action === "balance") return json(await this.deps.balance.get(connection, input.refresh === true));
    if (action === "discover_models") {
      const discovered = await adapterFor(connection.protocol).listModels(
        connection,
        signal,
        providerRequestContextForConversation(connection.id, "models")
      );
      const enrichment = await this.deps.catalog.enrich(connection, discovered);
      const changed: ModelDto[] = [];
      for (const item of enrichment.models) changed.push(this.deps.store.upsertDiscoveredModel(item.input, item.catalogMetadata).model);
      return this.changed("models", { discovered: discovered.length, models: changed, warning: enrichment.warning ?? null });
    }
    if (action === "delete") {
      if (!this.deps.store.deleteConnection(connection.id)) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
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
      if (!this.deps.store.getConnection(value.connectionId)) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
      return this.changed("models", this.deps.store.createModel(value));
    }
    if (action === "update") {
      const value = modelInputSchema.partial().parse(object(input));
      if (value.connectionId && !this.deps.store.getConnection(value.connectionId)) {
        throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
      }
      const model = this.deps.store.updateModel(id(input), value);
      if (!model) throw withMessage(new StoreError("model_not_found", "模型不存在"), "error.model_not_found");
      return this.changed("models", model, model.id);
    }
    if (action === "restore_catalog") {
      const model = requiredResource(this.deps.store.getModel(id(input)), "model_not_found", "模型不存在");
      const connection = requiredResource(this.deps.store.getConnection(model.connectionId), "connection_not_found", "连接不存在");
      const enriched = await this.deps.catalog.enrichOne(connection, model.modelKey, model.modelKey);
      if (!enriched?.catalogMetadata) throw withMessage(new StoreError("model_catalog_match_not_found", "模型目录中没有可信匹配"), "error.no_trusted_match_found_in_the_model_catalog");
      return this.changed("models", this.deps.store.restoreCatalogModel(model.id, enriched.input, enriched.catalogMetadata), model.id);
    }
    if (action === "delete") {
      if (!this.deps.store.deleteModel(id(input))) throw withMessage(new StoreError("model_not_found", "模型不存在"), "error.model_not_found");
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
      if (!server) throw withMessage(new StoreError("mcp_server_not_found", "MCP 服务不存在"), "error.mcp_server_not_found");
      mcpManager(this.deps.store).invalidate(server.id);
      return this.changed("mcp", server, server.id);
    }
    if (action === "test") return json(await mcpManager(this.deps.store).test(id(input)));
    if (action === "delete") {
      mcpManager(this.deps.store).invalidate(id(input));
      if (!this.deps.store.deleteMcpServer(id(input))) throw withMessage(new StoreError("mcp_server_not_found", "MCP 服务不存在"), "error.mcp_server_not_found");
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
        throw withMessage(new StoreError("secret_field_forbidden", "搜索 API Key 必须在 Agent 设置中修改"), "error.change_the_search_api_key_in_agent_settings");
      }
      const parsed = toolSettingsInputSchema.parse(value);
      return this.changed("tools", this.deps.store.updateToolSettings(parsed));
    }
    throw invalidAction(action);
  }

  private async roleplay(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    const action = string(input, "action");
    if (action === "get_agent") {
      return json(requiredResource(this.deps.store.getAgent(id(input)), "agent_not_found", "Agent 不存在").roleplay);
    }
    if (action === "update_agent") {
      const agent = requiredResource(this.deps.store.getAgent(id(input)), "agent_not_found", "Agent 不存在");
      const roleplay = agentRoleplayConfigSchema.parse({ ...agent.roleplay, ...object(input) });
      return this.changed("agents", this.deps.store.updateAgent(agent.id, { roleplay }), agent.id);
    }
    const conversationId = typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : context?.conversationId;
    if (!conversationId) throw new StoreError("app_tool_input_invalid", "id is required outside a conversation");
    if (action === "get_state") return json(this.deps.store.getConversationRoleplayState(conversationId));
    if (action === "update_state") {
      const state = this.deps.store.updateConversationRoleplayState(
        conversationId, conversationRoleplayStatePatchSchema.parse(object(input))
      );
      return this.changed("conversations", state, conversationId);
    }
    if (action === "audit") return json(this.deps.store.listRoleplayScriptAudit(conversationId));
    if (action === "run_script") {
      const conversation = requiredResource(this.deps.store.getConversation(conversationId), "conversation_not_found", "会话不存在");
      const agent = conversation.agentId ? this.deps.store.getAgent(conversation.agentId) : undefined;
      if (!agent?.roleplay.enabled) throw withMessage(new StoreError("roleplay_disabled", "当前 Agent 未启用角色扮演"), "error.roleplay_is_not_enabled_for_this_agent");
      const state = this.deps.store.getConversationRoleplayState(conversationId);
      try {
        const result = executeRestrictedStscript(string(input, "script"), typeof input.draft === "string" ? input.draft : "", state, agent.roleplay);
        const updated = this.deps.store.updateConversationRoleplayState(conversationId, result.patch);
        this.deps.store.recordRoleplayScriptAudit({
          conversationId, agentId: agent.id, sourceKind: "app_tool", commandCount: result.commands, success: true
        });
        return this.changed("conversations", { ...result, state: updated }, conversationId);
      } catch (error) {
        this.deps.store.recordRoleplayScriptAudit({
          conversationId, agentId: agent.id, sourceKind: "app_tool", commandCount: 0, success: false,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
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
      const owned = this.deps.store.conversationHasFileAsset(context!.conversationId, assetId);
      if (!owned) throw withMessage(new StoreError("file_asset_not_found", "当前会话没有该附件"), "error.this_conversation_does_not_contain_that_attachment");
      const loaded = await this.deps.files.readFileAsset(assetId);
      return { bytes: loaded.bytes, fileName: loaded.asset.fileName };
    }
    if (source === "url") return this.deps.files.fetchPublicFile(string(input, "url"), 10 * 1024 * 1024, signal);
    if (source === "workspace") {
      const path = await this.workspaceSource(input, context);
      const info = await stat(path);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw withMessage(new StoreError("card_too_large", "文件必须小于 10 MiB"), "error.the_file_must_be_smaller_than_10_mib");
      return { bytes: new Uint8Array(await readFile(path)), fileName: path.split(sep).at(-1) || "file" };
    }
    throw withMessage(new StoreError("file_source_invalid", "source 必须是 attachment、url 或 workspace"), "error.source_must_be_attachment_url_or_workspace");
  }

  private async workspaceSource(input: JsonObject, context?: ToolExecutionContext): Promise<string> {
    requireContext(context);
    const root = input.workspace === "project"
      ? context!.snapshot.workspacePath
      : this.deps.files.attachmentWorkspace(context!.conversationId);
    if (!root) throw withMessage(new StoreError("workspace_required", "当前会话没有项目工作区"), "error.this_conversation_has_no_project_workspace");
    const value = string(input, "path");
    if (isAbsolute(value)) throw withMessage(new StoreError("workspace_path_invalid", "路径必须相对工作区"), "error.the_path_must_be_relative_to_the_workspace");
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(resolve(root, value));
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw withMessage(new StoreError("workspace_path_invalid", "路径越过了工作区边界"), "error.the_path_crosses_the_workspace_boundary");
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
  if (!context) throw withMessage(new StoreError("tool_context_required", "该操作需要会话上下文"), "error.this_operation_requires_a_conversation_context");
}
function assertNoSecrets(input: JsonObject): void {
  if (Object.hasOwn(input, "apiKey") || Object.hasOwn(input, "secretHeaders")) {
    throw withMessage(new StoreError("secret_field_forbidden", "网站管理工具不能读取或修改连接密钥"), "error.app_management_tools_cannot_read_or_change_connection_secrets");
  }
}
function assertNoHeaders(input: JsonObject): void {
  if (Object.hasOwn(input, "headers")) throw withMessage(new StoreError("secret_field_forbidden", "网站管理工具不能读取或修改 MCP 请求头"), "error.app_management_tools_cannot_read_or_change_mcp_request_headers");
}
function invalidAction(action: string): StoreError { return withMessage(new StoreError("app_tool_action_invalid", `不支持的操作：${action}`), "error.unsupported_action", { value1: action }); }
function fileMarkdown(asset: FileAssetDto): string {
  const label = asset.fileName.replace(/[\[\]]/g, "") || "file";
  return asset.kind === "image" ? `![${label}](${asset.url})` : `[${label}](${asset.url})`;
}
