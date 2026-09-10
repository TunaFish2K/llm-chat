import { GenerationRunner } from "./generations";
import { ConversationService } from "./conversations";
import { ImageGenerationManager } from "./image-generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterCardV2 } from "@llm-chat/contracts";
import { AppTools } from "./app-tools";
import { BalanceService } from "./balance";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { ImageService } from "./images";
import { ModelCatalogService } from "./model-catalog";
import { PluginManager } from "./plugins";
import { SkillManager } from "./skills";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

afterEach(cleanupStores);

describe("application management tools", () => {
  it.each(["approved", "auto"] as const)("does not advertise deletion and rejects direct and %s legacy calls", async (approvalState) => {
    const { store, tools } = await setup();
    seedModel(store);
    const target = store.createConversation({ systemPrompt: "" });
    const caller = store.createConversation({ systemPrompt: "" });
    const tool = tools.tools().find((item) => item.definition.name === "app_conversations")!;
    expect(tool.definition.description).not.toMatch(/\bdelete\b/i);
    expect(JSON.stringify(tool.definition.inputSchema)).not.toContain('"delete"');
    await expect(tool.execute({ action: "delete", id: target.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });
    const generation = store.createMessageGeneration(caller.id, "old delete request");
    const record = store.getGenerationRecord(generation.generationId)!;
    record.agentSnapshot.execution.tools.overrides.app_conversations = true;
    record.agentSnapshot.execution.tools.directOverrides = { ...record.agentSnapshot.execution.tools.directOverrides, app_conversations: true };
    store.updateGenerationExtensionSnapshot(generation.generationId, record.agentSnapshot);
    store.upsertToolCall(generation.generationId, { id: "legacy-delete", name: "app_conversations",
      arguments: JSON.stringify({ action: "delete", id: target.id }) }, 0, 0, true);
    store.setGenerationWaitingApproval(generation.generationId);
    store.updateToolCall("legacy-delete", { approvalState });
    const runner = new GenerationRunner(store, {
      buildContext: async () => ({ systemPrompt: "", messages: [], metadata: { policy: "full", omittedMessages: 0, estimatedInputTokens: 1, summaryUsed: false } }),
      memoryPrompt: () => "",
      buildTools: async () => tools.tools(),
      stream: async function* () { yield { type: "complete", stopReason: "stop" }; }
    });
    try {
      runner.start(generation.generationId);
      await vi.waitFor(() => expect(store.getToolCall("legacy-delete")).toMatchObject({ approvalState: "failed" }));
      expect(store.getToolCall("legacy-delete")?.error).toContain("delete");
      expect(store.getConversation(target.id)).toBeDefined();
    } finally { await runner.close(); }
  });

  it("manages Agent-scoped roleplay through a restricted audited tool", async () => {
    const { store, tools } = await setup();
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    store.updateAgent(agent.id, { roleplay: { ...agent.roleplay, enabled: true } });
    const conversation = store.createConversation({ systemPrompt: "" });
    const tool = tools.tools().find((item) => item.definition.name === "app_roleplay")!;
    expect(await tool.requiresApproval({ action: "get_state" })).toBe(false);
    expect(await tool.requiresApproval({ action: "run_script" })).toBe(true);
    const result = JSON.parse(await tool.execute({
      action: "run_script", id: conversation.id, script: "/setvar mood calm | /input hello", draft: ""
    }, new AbortController().signal));
    expect(result).toMatchObject({ draft: "hello", state: { variables: { mood: "calm" } } });
    const audit = JSON.parse(await tool.execute({ action: "audit", id: conversation.id }, new AbortController().signal));
    expect(audit[0]).toMatchObject({ sourceKind: "app_tool", success: true });
  });

  it("requires approval for persistent changes and never exposes or accepts connection secrets", async () => {
    const { store, tools } = await setup();
    const connection = store.createConnection({
      name: "Private", protocol: "openai-chat", baseUrl: "https://example.test/v1",
      apiKey: "api-secret", secretHeaders: { Authorization: "header-secret" }
    });
    const connections = tools.tools().find((tool) => tool.definition.name === "app_connections")!;
    expect(await connections.requiresApproval({})).toBe(true);
    expect(await connections.requiresApproval({ action: "list" })).toBe(false);
    expect(await connections.requiresApproval({ action: "update" })).toBe(true);
    const listed = await connections.execute({ action: "list" }, new AbortController().signal);
    expect(listed).not.toContain("api-secret");
    expect(listed).not.toContain("header-secret");
    await expect(connections.execute({
      action: "update", id: connection.id, input: { apiKey: "replacement" }
    }, new AbortController().signal)).rejects.toMatchObject({ code: "secret_field_forbidden" });
    expect(store.getConnection(connection.id)?.apiKey).toBe("api-secret");
  });

  it("installs a character card from the current conversation without switching agents or granting app tools", async () => {
    const { store, files, tools } = await setup();
    const seeded = seedModel(store);
    const originalAgentId = store.getSettings().defaultAgentId;
    const card: CharacterCardV2 = {
      ...store.getAgent(originalAgentId)!.card,
      data: { ...store.getAgent(originalAgentId)!.card.data, name: "Imported Role" }
    };
    const asset = await files.importFile("role.json", "application/json", Buffer.from(JSON.stringify(card)));
    const conversation = store.createConversation({
      systemPrompt: "",
      agentId: originalAgentId,
      executionOverrides: { modelId: seeded.model.id }
    });
    const generation = store.createMessageGeneration(conversation.id, "install this", [asset.id]);
    const appAgents = tools.tools().find((tool) => tool.definition.name === "app_agents")!;
    const result = JSON.parse(await appAgents.execute({
      action: "import", source: "attachment", asset_id: asset.id
    }, new AbortController().signal, {
      conversationId: conversation.id,
      generationId: generation.generationId,
      toolCallId: "unused",
      snapshot: store.getGenerationRecord(generation.generationId)!.agentSnapshot
    }));
    expect(result.name).toBe("Imported Role");
    expect(store.getSettings().defaultAgentId).toBe(originalAgentId);
    expect(Object.values(result.execution.tools.overrides).filter(Boolean)).toEqual([]);
    expect(result.execution.tools.directOverrides).not.toMatchObject({ app_agents: true });
    expect(seeded.model.id).toBeTruthy();
  });

  it("rejects missing resources, unsafe sources, busy targets, and invalid actions", async () => {
    const { store, files, tasks, tools } = await setup();
    const seeded = seedModel(store);
    const selected = (name: string) => tools.tools().find((tool) => tool.definition.name === name)!;
    const invoke = (name: string, input: Record<string, unknown>, context?: Parameters<ReturnType<AppTools["tools"]>[number]["execute"]>[2]) =>
      selected(name).execute(input, new AbortController().signal, context);
    const missing = "00000000-0000-4000-8000-000000000000";

    await expect(invoke("app_agents", { action: "get", id: " " })).rejects.toMatchObject({ code: "app_tool_input_invalid" });
    await expect(invoke("app_agents", { action: "create", input: [] })).rejects.toMatchObject({ code: "app_tool_input_invalid" });
    await expect(invoke("app_agents", { action: "update", id: missing, input: {} })).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(invoke("app_agents", { action: "set_avatar", id: missing, source: "attachment", asset_id: missing })).rejects.toMatchObject({ code: "tool_context_required" });
    await expect(invoke("app_agents", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
    vi.spyOn(tasks, "hasNonterminalForAgent").mockReturnValueOnce(true);
    await expect(invoke("app_agents", { action: "delete", id: store.getSettings().defaultAgentId })).rejects.toMatchObject({ code: "agent_busy" });
    await expect(invoke("app_agents", { action: "delete", id: missing })).rejects.toMatchObject({ code: "agent_not_found" });

    const file = await files.importFile("notes.txt", "text/plain", Buffer.from("not an avatar"));
    const png = await files.importBytes("avatar.png", ONE_PIXEL_PNG);
    const conversation = store.createConversation({ systemPrompt: "" });
    const generation = store.createMessageGeneration(conversation.id, "attachments", [file.id, png.id]);
    const call = store.upsertToolCall(generation.generationId, {
      id: "app-export", name: "app_agents", arguments: "{}"
    }, 0, 0, false);
    const context = {
      conversationId: conversation.id,
      generationId: generation.generationId,
      toolCallId: call.id,
      snapshot: store.getGenerationRecord(generation.generationId)!.agentSnapshot
    };
    expect(JSON.parse(await invoke("app_conversations", {
      action: "select_generation",
      message_id: generation.assistantMessageId,
      generation_id: generation.generationId
    }))).toEqual({ success: true, messageId: generation.assistantMessageId });
    await expect(invoke("app_agents", {
      action: "set_avatar", id: store.getSettings().defaultAgentId, source: "attachment", asset_id: missing
    }, context)).rejects.toMatchObject({ code: "file_asset_not_found" });
    await expect(invoke("app_agents", {
      action: "set_avatar", id: store.getSettings().defaultAgentId, source: "attachment", asset_id: file.id
    }, context)).rejects.toMatchObject({ code: "agent_avatar_invalid" });
    await expect(invoke("app_agents", {
      action: "set_avatar", id: missing, source: "attachment", asset_id: png.id
    }, context)).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(invoke("app_agents", {
      action: "set_avatar", id: store.getSettings().defaultAgentId, source: "unknown"
    }, context)).rejects.toMatchObject({ code: "file_source_invalid" });
    await expect(invoke("app_agents", {
      action: "import", source: "url", url: "http://127.0.0.1/card.json"
    }, context)).rejects.toMatchObject({ code: "image_proxy_private_address" });
    await expect(invoke("app_agents", {
      action: "import", source: "workspace", workspace: "project", path: "card.json"
    }, context)).rejects.toMatchObject({ code: "workspace_required" });
    await expect(invoke("app_agents", {
      action: "import", source: "workspace", path: "/absolute/card.json"
    }, context)).rejects.toMatchObject({ code: "workspace_path_invalid" });

    expect(JSON.parse(await invoke("app_agents", {
      action: "set_avatar", id: store.getSettings().defaultAgentId, source: "attachment", asset_id: png.id
    }, context))).toMatchObject({ hasAvatar: true });
    const jsonExport = JSON.parse(await invoke("app_agents", {
      action: "export", id: store.getSettings().defaultAgentId, format: "json"
    }, context));
    const pngExport = JSON.parse(await invoke("app_agents", {
      action: "export", id: store.getSettings().defaultAgentId, format: "png"
    }, context));
    expect(jsonExport.markdown).toMatch(/^\[/);
    expect(pngExport.markdown).toMatch(/^!\[/);
    expect(JSON.parse(await invoke("app_agents", {
      action: "remove_avatar", id: store.getSettings().defaultAgentId
    }))).toMatchObject({ hasAvatar: false });
    await expect(invoke("app_agents", { action: "remove_avatar", id: missing })).rejects.toMatchObject({ code: "agent_not_found" });

    const emptyConversation = JSON.parse(await invoke("app_conversations", {
      action: "create", input: { agentId: store.getSettings().defaultAgentId }
    }));
    await expect(invoke("app_conversations", { action: "update", id: missing, input: { title: "missing" } }))
      .rejects.toMatchObject({ code: "conversation_not_found" });
    await expect(invoke("app_conversations", { action: "delete", id: conversation.id }, context))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_conversations", { action: "delete", id: conversation.id }))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_conversations", { action: "delete", id: missing }))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_conversations", {
      action: "select_generation", message_id: missing, generation_id: missing
    })).rejects.toMatchObject({ code: "generation_not_found" });
    await expect(invoke("app_conversations", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
    expect(emptyConversation.title).toBe("新对话");

    await expect(invoke("app_settings", { action: "update", input: { defaultModelId: missing } }))
      .rejects.toThrow(/生成配置已移至 Agent/);
    await expect(invoke("app_settings", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });

    const connectionInput = { name: "Managed", protocol: "openai-chat", baseUrl: "https://managed.test/v1" };
    await expect(invoke("app_connections", { action: "create", input: { ...connectionInput, secretHeaders: {} } }))
      .rejects.toMatchObject({ code: "secret_field_forbidden" });
    await expect(invoke("app_connections", { action: "update", id: missing, input: { name: "missing" } }))
      .rejects.toMatchObject({ code: "connection_not_found" });
    await expect(invoke("app_connections", { action: "invalid", id: seeded.connection.id }))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });

    const modelInput = {
      connectionId: missing,
      modelKey: "missing-connection",
      displayName: "Missing Connection",
      contextWindow: 4096,
      maxOutputTokens: 256,
      capabilities: seeded.model.capabilities,
      defaultSettings: seeded.model.defaultSettings,
      enabled: true
    };
    expect(JSON.parse(await invoke("app_models", { action: "list" }))).toEqual(expect.any(Array));
    await expect(invoke("app_models", { action: "create", input: modelInput }))
      .rejects.toMatchObject({ code: "connection_not_found" });
    await expect(invoke("app_models", { action: "update", id: seeded.model.id, input: { connectionId: missing } }))
      .rejects.toMatchObject({ code: "connection_not_found" });
    await expect(invoke("app_models", { action: "update", id: missing, input: { displayName: "missing" } }))
      .rejects.toMatchObject({ code: "model_not_found" });
    await expect(invoke("app_models", { action: "restore_catalog", id: missing }))
      .rejects.toMatchObject({ code: "model_not_found" });
    await expect(invoke("app_models", { action: "delete", id: missing }))
      .rejects.toMatchObject({ code: "model_not_found" });
    await expect(invoke("app_models", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });

    const mcp = store.createMcpServer({ name: "Temporary", url: "https://mcp.test", headers: {}, enabled: false });
    await expect(invoke("app_mcp_servers", { action: "update", id: missing, input: { enabled: false } }))
      .rejects.toMatchObject({ code: "mcp_server_not_found" });
    await expect(invoke("app_mcp_servers", { action: "delete", id: missing }))
      .rejects.toMatchObject({ code: "mcp_server_not_found" });
    await expect(invoke("app_mcp_servers", { action: "invalid", id: mcp.id }))
      .rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_skills", { action: "install", path: "skill" }))
      .rejects.toMatchObject({ code: "tool_context_required" });
    await expect(invoke("app_skills", { action: "reload", id: missing })).rejects.toThrow("Skill not found");
    await expect(invoke("app_skills", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_plugins", { action: "install", path: "plugin" }))
      .rejects.toMatchObject({ code: "tool_context_required" });
    await expect(invoke("app_plugins", { action: "configure", id: missing, input: {} })).rejects.toThrow("Plugin not found");
    await expect(invoke("app_plugins", { action: "reload", id: missing })).rejects.toThrow("Plugin not found");
    await expect(invoke("app_plugins", { action: "unload", id: missing })).rejects.toThrow("Plugin not found");
    await expect(invoke("app_plugins", { action: "delete", id: missing })).rejects.toThrow("Plugin not found");
    await expect(invoke("app_plugins", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
    await expect(invoke("app_tool_settings", { action: "invalid" })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
  });

  it("performs the core non-secret resource lifecycles and emits usable results", async () => {
    const { store, tools } = await setup();
    const seeded = seedModel(store);
    const run = async (name: string, input: Record<string, unknown>, context?: Parameters<ReturnType<AppTools["tools"]>[number]["execute"]>[2]) => {
      const selected = tools.tools().find((tool) => tool.definition.name === name)!;
      return JSON.parse(await selected.execute(input, new AbortController().signal, context));
    };

    expect(await run("app_settings", { action: "get" })).toMatchObject({ theme: "system" });
    expect(await run("app_settings", { action: "update", input: { theme: "dark" } })).toMatchObject({ theme: "dark" });
    await expect(run("app_settings", {
      action: "update", input: { defaultAgentId: "00000000-0000-4000-8000-000000000000" }
    })).rejects.toMatchObject({ code: "agent_not_found" });

    const connection = await run("app_connections", {
      action: "create",
      input: { name: "Managed", protocol: "openai-chat", baseUrl: "https://managed.test/v1" }
    });
    expect(connection).toMatchObject({ name: "Managed", hasApiKey: false });
    expect(await run("app_connections", { action: "get", id: connection.id })).toMatchObject({ id: connection.id });
    expect(await run("app_connections", {
      action: "update", id: connection.id, input: { name: "Managed Updated" }
    })).toMatchObject({ name: "Managed Updated" });

    const modelInput = {
      connectionId: connection.id,
      modelKey: "managed-model",
      displayName: "Managed Model",
      contextWindow: 4096,
      maxOutputTokens: 256,
      capabilities: seeded.model.capabilities,
      defaultSettings: seeded.model.defaultSettings,
      enabled: true
    };
    const model = await run("app_models", { action: "create", input: modelInput });
    expect(await run("app_models", { action: "list", id: connection.id })).toEqual([
      expect.objectContaining({ id: model.id })
    ]);
    expect(await run("app_models", { action: "get", id: model.id })).toMatchObject({ modelKey: "managed-model" });
    expect(await run("app_models", {
      action: "update", id: model.id, input: { displayName: "Managed Model 2" }
    })).toMatchObject({ displayName: "Managed Model 2" });

    const agent = await run("app_agents", {
      action: "create",
      input: {
        card: { ...store.getAgent(store.getSettings().defaultAgentId)!.card,
          data: { ...store.getAgent(store.getSettings().defaultAgentId)!.card.data, name: "Managed Agent" } },
        execution: { ...store.getAgent(store.getSettings().defaultAgentId)!.execution, modelId: model.id },
        userProfile: {}
      }
    });
    expect(await run("app_agents", { action: "list" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: agent.id })
    ]));
    expect(await run("app_agents", { action: "get", id: agent.id })).toMatchObject({ name: "Managed Agent" });
    const updatedCard = { ...agent.card, data: { ...agent.card.data, description: "Updated by tool" } };
    expect(await run("app_agents", {
      action: "update", id: agent.id, input: { card: updatedCard }
    })).toMatchObject({ description: "Updated by tool" });

    const conversation = await run("app_conversations", {
      action: "create", input: { title: "Managed Chat", agentId: agent.id, executionOverrides: { modelId: model.id } }
    });
    expect(await run("app_conversations", { action: "get", id: conversation.id })).toMatchObject({
      conversation: { id: conversation.id }, messages: []
    });
    expect(await run("app_conversations", {
      action: "update", id: conversation.id, input: { title: "Renamed Chat" }
    })).toMatchObject({ title: "Renamed Chat" });
    await expect(run("app_conversations", {
      action: "update", id: conversation.id, input: { workspacePath: "/tmp" }
    })).rejects.toMatchObject({ code: "app_workspace_path_forbidden" });
    const fork = await run("app_conversations", { action: "fork", id: conversation.id, through_message_id: null });
    expect(fork.conversation.forkedFrom.conversationId).toBe(conversation.id);
    expect(await run("app_conversations", { action: "list" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: conversation.id }), expect.objectContaining({ id: fork.conversation.id })
    ]));
    await expect(run("app_conversations", { action: "delete", id: fork.conversation.id })).rejects.toMatchObject({ code: "app_tool_action_invalid" });

    const mcp = await run("app_mcp_servers", {
      action: "create", input: { name: "ManagedMcp", url: "https://mcp.test", enabled: true }
    });
    expect(await run("app_mcp_servers", { action: "list" })).toEqual([expect.objectContaining({ id: mcp.id })]);
    expect(await run("app_mcp_servers", { action: "get", id: mcp.id })).toMatchObject({ name: "ManagedMcp" });
    expect(await run("app_mcp_servers", {
      action: "update", id: mcp.id, input: { enabled: false }
    })).toMatchObject({ enabled: false });
    await expect(run("app_mcp_servers", {
      action: "update", id: mcp.id, input: { headers: { Authorization: "secret" } }
    })).rejects.toMatchObject({ code: "secret_field_forbidden" });
    expect(await run("app_mcp_servers", { action: "delete", id: mcp.id })).toEqual({ success: true });

    expect(await run("app_skills", { action: "list" })).toEqual([]);
    expect(await run("app_skills", { action: "discover" })).toMatchObject({ errors: [] });
    expect(await run("app_plugins", { action: "list" })).toEqual([]);
    expect(await run("app_tool_settings", { action: "get" })).toMatchObject({ workspaceShellEnabled: true });
    expect(await run("app_tool_settings", {
      action: "update", input: { workspaceShellEnabled: false }
    })).toMatchObject({ workspaceShellEnabled: false });
    await expect(run("app_tool_settings", {
      action: "update", input: { search: { baseUrl: "", apiKey: "secret" } }
    })).rejects.toMatchObject({ code: "secret_field_forbidden" });

    await expect(run("app_conversations", { action: "delete", id: conversation.id })).rejects.toMatchObject({ code: "app_tool_action_invalid" });
    expect(await run("app_agents", { action: "delete", id: agent.id })).toEqual({ success: true });
    expect(await run("app_models", { action: "delete", id: model.id })).toEqual({ success: true });
    expect(await run("app_connections", { action: "delete", id: connection.id })).toEqual({ success: true });
  });
});

async function setup() {
  const store = createStore();
  const events = new EventHub();
  const files = new ImageService(store);
  await files.initialize();
  const tasks = new TaskManager(store, events);
  const tools = new AppTools({
    store,
    conversations: new ConversationService({ store, tasks, files, events, imageJobs: new ImageGenerationManager(store, files, events), startGeneration: () => { throw new Error("Management tools cannot start generations"); } }),
    tasks,
    plugins: new PluginManager(store, events),
    skills: new SkillManager(store, events, { discoveryRoot: `${store.dataDir}/agent-skills` }),
    files,
    events,
    balance: new BalanceService(),
    catalog: new ModelCatalogService()
  });
  return { store, files, tasks, tools };
}
