import { recoverInterruptedWork } from "./runtime/startup-recovery";
import { updateDefaultAgentExecution } from "./test-helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_V1, Store } from "./database";
import { resolveManualThinkingBudget } from "./generation-policy";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { appSettingsUpdateSchema } from "@llm-chat/contracts";
import { defaultRoleplayConfig } from "./roleplay";

const dirs: string[] = [];
afterEach(() => {
  cleanupStores();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  it("merges typography patches without resetting unrelated preferences", () => {
    const store = createStore();
    store.updateSettings({ lastWorkspacePath: "/tmp/preserve-workspace", uiPreferences: { generationHaptics: false, accentColor: "#018EEE" } });
    const patch = appSettingsUpdateSchema.parse({ uiPreferences: { chatFontSize: 18 } });
    expect(patch).toEqual({ uiPreferences: { chatFontSize: 18 } });
    store.updateSettings(patch);
    store.updateSettings({ uiPreferences: { chatLetterSpacing: 0.08, chatLineHeight: 1.9 } });
    store.updateSettings({ theme: "light" });
    expect(store.getSettings().uiPreferences).toMatchObject({ chatFontSize: 18, chatLetterSpacing: 0.08, chatLineHeight: 1.9, generationHaptics: false, accentColor: "#018EEE" });
    expect(store.getSettings().lastWorkspacePath).toBe("/tmp/preserve-workspace");
    for (const values of [{ chatFontSize: 30 }, { chatLetterSpacing: -1 }, { chatLineHeight: 0 }]) {
      expect(appSettingsUpdateSchema.safeParse({ uiPreferences: values }).success).toBe(false);
    }
  });

  it("upgrades typography from schema 37 and persists it across reopening", () => {
    const store = createStore();
    store.updateSettings({ uiPreferences: { generationHaptics: false } });
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.sqlite.exec("ALTER TABLE app_settings DROP COLUMN chat_font_size; ALTER TABLE app_settings DROP COLUMN chat_letter_spacing; ALTER TABLE app_settings DROP COLUMN chat_line_height; PRAGMA user_version = 37;");
    store.close();
    const upgraded = new Store(path);
    expect(upgraded.getSettings().uiPreferences).toMatchObject({ chatFontSize: 13.5, chatLetterSpacing: 0, chatLineHeight: 1.55, generationHaptics: false });
    upgraded.updateSettings({ uiPreferences: { chatFontSize: 20 } });
    upgraded.close();
    const reopened = new Store(path);
    expect(reopened.getSettings().uiPreferences.chatFontSize).toBe(20);
    reopened.close();
  });

  it("stores Agent-scoped roleplay state and clones it with a conversation branch", () => {
    const store = createStore();
    const agentId = store.getSettings().defaultAgentId;
    const agent = store.getAgent(agentId)!;
    const roleplay = defaultRoleplayConfig(true);
    roleplay.personas = [{ id: "traveler", name: "Traveler", description: "", avatarAssetId: null }];
    roleplay.defaultPersonaId = "traveler";
    store.updateAgent(agent.id, { roleplay });
    const conversation = store.createConversation({ systemPrompt: "" });
    const state = store.updateConversationRoleplayState(conversation.id, {
      authorNote: "Keep this branch note",
      variables: { chapter: 2 },
      personaId: "traveler"
    });
    const fork = store.forkConversation(conversation.id, { mode: "continue", throughMessageId: null });

    expect(state).toMatchObject({ authorNote: "Keep this branch note", variables: { chapter: 2 } });
    expect(store.getConversationRoleplayState(fork.conversation.id)).toEqual(state);
  });

  it("inserts xhigh between the existing manual Thinking budget tiers", () => {
    expect(resolveManualThinkingBudget("high", 10_000)).toBe(5_500);
    expect(resolveManualThinkingBudget("xhigh", 10_000)).toBe(6_750);
    expect(resolveManualThinkingBudget("max", 10_000)).toBe(8_000);
    expect(resolveManualThinkingBudget("xhigh", 10_000, 2_000)).toBe(4_400);
  });

  it("enables the bundled llm-chat operator for the protected default Agent", () => {
    const store = createStore();
    const defaultAgentId = store.getSettings().defaultAgentId!;
    expect(store.getAgent(defaultAgentId)?.execution.enabledSkillIds).toEqual(
      expect.arrayContaining(["command-execution-guide", "llm-chat-operator"])
    );

    const row = store.sqlite.prepare("SELECT execution_json FROM agents WHERE id = ?").get(defaultAgentId) as { execution_json: string };
    const execution = JSON.parse(row.execution_json);
    execution.enabledSkillIds = execution.enabledSkillIds.filter((id: string) => id !== "llm-chat-operator");
    store.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?").run(JSON.stringify(execution), defaultAgentId);
    store.sqlite.exec("PRAGMA user_version = 21");
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();

    const upgraded = new Store(path);
    expect(upgraded.getAgent(defaultAgentId)?.execution.enabledSkillIds).toContain("llm-chat-operator");
    upgraded.close();
  });

  it("keeps provider secrets server-only and persists UI state", () => {
    const store = createStore();
    const connection = store.createConnection({
      name: "测试连接",
      protocol: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "top-secret",
      secretHeaders: { "X-Secret": "header-secret" }
    });
    expect(connection).toMatchObject({ hasApiKey: true, secretHeaderNames: ["X-Secret"] });
    expect(JSON.stringify(connection)).not.toContain("top-secret");
    expect(store.getConnection(connection.id)?.apiKey).toBe("top-secret");
    expect(store.updateSettings({ theme: "dark" }).theme).toBe("dark");
    store.updateSettings({ uiPreferences: { ...store.getSettings().uiPreferences, accentColor: "#018EEE", amoled: true } });
    expect(store.getSettings().uiPreferences).toMatchObject({ accentColor: "#018EEE", amoled: true });
    const conversation = store.createConversation({ systemPrompt: "system" });
    expect(store.updateConversation(conversation.id, { draft: "未发送" })?.draft).toBe("未发送");
    store.close();
  });

  it("stores immutable messages and selectable generation versions", () => {
    const store = createStore();
    const { connection, model, settings } = seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    expect(conversation.modelId).toBe(model.id);
    const first = store.createMessageGeneration(conversation.id, "第一条消息");
    store.setGenerationRunning(first.generationId);
    store.updateGenerationBlock(first.generationId, 1, "text", "第一版", true);
    store.finishGeneration(first.generationId, "completed", { stopReason: "stop" });
    const secondModel = store.createModel({
      connectionId: connection.id,
      modelKey: "second-model",
      displayName: "Second Model",
      contextWindow: 2048,
      maxOutputTokens: 128,
      capabilities: model.capabilities,
      defaultSettings: settings,
      enabled: true
    });
    store.updateConversation(conversation.id, { modelId: secondModel.id });
    const retry = store.createRetryGeneration(first.assistantMessageId);
    store.setGenerationRunning(retry.generationId);
    store.updateGenerationBlock(retry.generationId, 1, "text", "第二版", true);
    store.finishGeneration(retry.generationId, "completed", { stopReason: "stop" });
    expect(store.listMessages(conversation.id)[1]).toMatchObject({
      activeGenerationId: retry.generationId,
      generatedModel: { modelId: secondModel.id, displayName: "Second Model" },
      generations: [{ version: 1 }, { version: 2 }]
    });
    expect(store.listMessages(conversation.id)[0]?.generatedModel).toBeNull();
    expect(store.selectGeneration(first.assistantMessageId, first.generationId)).toBe(true);
    expect(store.listMessages(conversation.id)[1]).toMatchObject({
      activeGenerationId: first.generationId,
      generatedModel: { modelId: model.id, displayName: "Mock Model" }
    });
    store.updateModel(secondModel.id, { enabled: false });
    expect(store.getConversation(conversation.id)?.modelId).toBe(secondModel.id);
    store.close();
  });

  it("applies display regex without changing the stored generation block", () => {
    const store = createStore();
    seedModel(store);
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    store.updateAgent(agent.id, {
      roleplay: {
        ...agent.roleplay,
        enabled: true,
        regexScripts: [{
          id: "hide-status", name: "Hide status", enabled: true,
          pattern: "<status>[\\s\\S]*?</status>", replacement: "", flags: "gu",
          scopes: ["display"], runOnEdit: false, importWarning: null
        }]
      }
    });
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "continue");
    store.setGenerationRunning(created.generationId);
    store.updateGenerationBlock(created.generationId, 1, "text", "Visible<status>private</status>", true);
    store.finishGeneration(created.generationId, "completed", { stopReason: "stop" });

    const assistant = store.listMessages(conversation.id)[1]!;
    const active = assistant.generations.find((generation) => generation.id === assistant.activeGenerationId);
    expect(active?.blocks[0]?.content).toBe("Visible");
    const raw = store.sqlite.prepare(
      "SELECT content FROM generation_blocks WHERE generation_id = ? AND block_index = 1"
    ).get(created.generationId) as { content: string };
    expect(raw.content).toBe("Visible<status>private</status>");
    store.close();
  });

  it("stores generic attachment metadata and enforces per-message quotas atomically", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const files = Array.from({ length: 9 }, (_, index) => store.createFileAsset({
      sha256: index.toString(16).padStart(64, "0"),
      fileName: `file-${index}.bin`,
      mimeType: "application/octet-stream",
      kind: "file",
      byteSize: 1,
      storageKey: `blob-${index}`
    }));
    expect(() => store.createMessageGeneration(conversation.id, "too many", files.map((file) => file.id)))
      .toThrow("最多包含 8 个");
    expect(store.listMessages(conversation.id)).toEqual([]);

    const created = store.createMessageGeneration(conversation.id, "files", files.slice(0, 2).map((file) => file.id));
    expect(store.listMessages(conversation.id)[0]?.attachments).toEqual([
      expect.objectContaining({ id: files[0]!.id, kind: "file", url: expect.stringMatching(/^\/api\/files\//) }),
      expect.objectContaining({ id: files[1]!.id, kind: "file" })
    ]);
    expect(() => store.attachFilesToMessage(created.userMessageId!, [files[0]!.id, files[0]!.id]))
      .toThrow("不重复附件");
    store.close();
  });

  it("forks the visible path without mutating the source conversation", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const first = store.createMessageGeneration(conversation.id, "第一问");
    store.updateGenerationBlock(first.generationId, 1, "text", "第一版", true);
    store.finishGeneration(first.generationId, "completed", { stopReason: "stop" });
    const retry = store.createRetryGeneration(first.assistantMessageId);
    store.updateGenerationBlock(retry.generationId, 1, "text", "当前可见版本", true);
    store.upsertToolCall(retry.generationId, { id: "provider-call", name: "lookup", arguments: "{}" }, 0, 0, false);
    store.updateToolCall("provider-call", { approvalState: "completed", output: "result" });
    store.finishGeneration(retry.generationId, "completed", { stopReason: "stop" });
    const second = store.createMessageGeneration(conversation.id, "第二问");
    store.updateGenerationBlock(second.generationId, 1, "text", "第二答", true);
    store.finishGeneration(second.generationId, "completed", { stopReason: "stop" });

    const fork = store.forkConversation(conversation.id, {
      mode: "edit",
      messageId: second.userMessageId!,
      text: "修改后的第二问",
      imageAssetIds: []
    });
    const forkMessages = store.listMessages(fork.conversation.id);

    expect(fork.conversation).toMatchObject({ title: store.getConversation(conversation.id)?.title });
    expect(fork.conversation.forkedFrom).toEqual({
      conversationId: conversation.id,
      messageId: second.userMessageId,
      messageOrdinal: 3,
      mode: "edit",
      greetingIndex: null,
      sourceGreetingIndex: null
    });
    expect(fork.generation).not.toBeNull();
    expect(forkMessages.map((message) => [message.role, message.text])).toEqual([
      ["user", "第一问"], ["assistant", null], ["user", "修改后的第二问"], ["assistant", null]
    ]);
    expect(forkMessages[1]?.generations).toEqual([
      expect.objectContaining({ version: 1, blocks: [expect.objectContaining({ content: "当前可见版本" })] })
    ]);
    expect(forkMessages[1]?.generations[0]?.toolCalls[0]).toMatchObject({
      providerId: "provider-call", name: "lookup", output: "result"
    });
    expect(forkMessages[1]?.generations[0]?.toolCalls[0]?.id).not.toBe("provider-call");
    expect(store.listMessages(conversation.id)[1]?.generations).toHaveLength(2);

    const root = store.forkConversation(conversation.id, { mode: "continue", throughMessageId: null });
    expect(root.generation).toBeNull();
    expect(root.conversation.forkedFrom).toEqual({
      conversationId: conversation.id,
      messageId: null,
      messageOrdinal: null,
      mode: "continue",
      greetingIndex: null,
      sourceGreetingIndex: null
    });
    expect(store.listMessages(root.conversation.id)).toEqual([]);
    expect(store.deleteConversation(conversation.id)).toBe(true);
    expect(store.listConversations()).toEqual([]);
    store.close();
  });

  it("starts a conversation and its first generation atomically", () => {
    const store = createStore();
    const { model } = seedModel(store);
    updateDefaultAgentExecution(store, { baseSystemPrompt: "server system", contextPolicy: "full" });

    const started = store.startConversation({
      text: "  第一条消息  ",
      modelId: model.id,
      contextPolicy: "summarize"
    });

    expect(started.conversation).toMatchObject({
      title: "第一条消息",
      systemPrompt: "",
      contextPolicy: "summarize",
      modelId: model.id
    });
    // Fresh stores default the global effort to none.
    const generation = store.getGeneration(started.generation.generationId)!;
    expect(generation.settings).toMatchObject({
      common: { maxOutputTokens: 128, stopSequences: [] },
      protocol: {},
      reasoningEffort: "none"
    });
    expect(store.listMessages(started.conversation.id)).toEqual([
      expect.objectContaining({ role: "user", text: "  第一条消息  ", generatedModel: null }),
      expect.objectContaining({
        role: "assistant",
        generatedModel: expect.objectContaining({ modelId: model.id }),
        activeGenerationId: started.generation.generationId
      })
    ]);

    store.updateModel(model.id, { enabled: false });
    expect(() => store.startConversation({ text: "不会创建", modelId: model.id })).toThrow("模型已停用");
    expect(store.listConversations()).toHaveLength(1);
    store.close();
  });

  it("snapshots alternate greetings and switches them through an immutable root branch", () => {
    const store = createStore();
    const { model } = seedModel(store);
    const settings = store.getSettings();
    const agent = store.getAgent(settings.defaultAgentId)!;
    const updated = store.updateAgent(agent.id, {
      card: {
        ...agent.card,
        data: {
          ...agent.card.data,
          first_mes: "你好，{{user}}。",
          alternate_greetings: ["欢迎来到 {{char}} 的世界。"]
        }
      }
    })!;
    store.updateSettings({ userProfile: { displayName: "旅行者", description: "" } });

    const started = store.startConversation({
      text: "开始",
      agentId: updated.id,
      greetingIndex: 1,
      executionOverrides: { modelId: model.id },
      workspacePath: null
    });
    store.finishGeneration(started.generation.generationId, "completed", { stopReason: "stop" });
    const sourceGreeting = store.listMessages(started.conversation.id)[0]!;
    expect(sourceGreeting).toMatchObject({
      role: "assistant",
      text: "欢迎来到 默认助手 的世界。",
      greeting: {
        activeIndex: 1,
        variants: ["你好，旅行者。", "欢迎来到 默认助手 的世界。"],
        agent: { agentId: updated.id, revision: updated.revision }
      }
    });

    const fork = store.forkConversation(started.conversation.id, {
      mode: "greeting",
      messageId: sourceGreeting.id,
      greetingIndex: 0
    });
    expect(fork.generation).toBeNull();
    expect(fork.conversation.forkedFrom).toEqual({
      conversationId: started.conversation.id,
      messageId: sourceGreeting.id,
      messageOrdinal: 1,
      mode: "greeting",
      greetingIndex: 0,
      sourceGreetingIndex: 1
    });
    expect(store.listMessages(fork.conversation.id)).toEqual([
      expect.objectContaining({ text: "你好，旅行者。", greeting: expect.objectContaining({ activeIndex: 0 }) })
    ]);
    expect(store.listMessages(started.conversation.id)).toHaveLength(3);
    store.close();
  });

  it("persists the selected branch for a conversation family", () => {
    const store = createStore();
    seedModel(store);
    const root = store.createConversation({ systemPrompt: "" });
    const first = store.forkConversation(root.id, { mode: "continue", throughMessageId: null }).conversation;
    const second = store.forkConversation(first.id, { mode: "continue", throughMessageId: null }).conversation;
    const third = store.forkConversation(second.id, { mode: "continue", throughMessageId: null }).conversation;

    expect(store.getConversation(root.id)?.activeBranchId).toBe(third.id);
    expect(store.selectConversationBranch(root.id, first.id)).toEqual({ activeBranchId: first.id });
    expect(store.listConversations().find((item) => item.id === root.id)?.activeBranchId).toBe(first.id);

    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();
    const reopened = new Store(path);
    expect(reopened.getConversation(root.id)?.activeBranchId).toBe(first.id);
    reopened.close();
  });

  it("backfills stable branch metadata when migrating a v22 database", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const first = store.createMessageGeneration(conversation.id, "原问题");
    store.finishGeneration(first.generationId, "completed", { stopReason: "stop" });
    const fork = store.forkConversation(conversation.id, {
      mode: "edit",
      messageId: first.userMessageId!,
      text: "修改后的问题",
      imageAssetIds: []
    });
    const greetingConversation = store.createConversation({ systemPrompt: "" });
    const greetingMessageId = "legacy-greeting";
    store.sqlite.prepare(`
      INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at, greeting_json)
      VALUES (?, ?, 1, 'assistant', '开场白', NULL, ?, ?)
    `).run(greetingMessageId, greetingConversation.id, Date.now(), JSON.stringify({
      variants: ["开场白", "另一个开场白"],
      activeIndex: 0,
      agent: { agentId: "legacy-agent", name: "旧 Agent", revision: 1 }
    }));
    const continued = store.forkConversation(greetingConversation.id, {
      mode: "continue",
      throughMessageId: greetingMessageId
    });
    store.sqlite.prepare(`
      UPDATE conversations SET fork_mode = NULL, fork_point_ordinal = NULL,
        fork_greeting_index = NULL, fork_source_greeting_index = NULL
      WHERE id IN (?, ?)
    `).run(fork.conversation.id, continued.conversation.id);
    store.sqlite.exec("PRAGMA user_version = 22");
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();

    const migrated = new Store(path);
    expect(migrated.getConversation(fork.conversation.id)?.forkedFrom).toEqual({
      conversationId: conversation.id,
      messageId: first.userMessageId,
      messageOrdinal: 1,
      mode: "edit",
      greetingIndex: null,
      sourceGreetingIndex: null
    });
    expect(migrated.getConversation(continued.conversation.id)?.forkedFrom).toEqual({
      conversationId: greetingConversation.id,
      messageId: greetingMessageId,
      messageOrdinal: 1,
      mode: "continue",
      greetingIndex: 0,
      sourceGreetingIndex: 0
    });
    expect((migrated.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    migrated.close();
  });

  it("keeps catalog-managed models current until a manual metadata edit locks them", () => {
    const store = createStore();
    const { connection, model } = seedModel(store);
    const metadata = {
      providerId: "mock",
      modelId: "mock-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      reasoningEfforts: [],
      fetchedAt: 1
    };
    const discovered = store.upsertDiscoveredModel({
      ...model,
      contextWindow: 8_192,
      maxInputTokens: 7_000,
      maxOutputTokens: 512
    }, metadata);
    expect(discovered.status).toBe("skipped");

    const managedInput = {
      ...model,
      connectionId: connection.id,
      modelKey: "catalog-model",
      displayName: "Catalog Model",
      contextWindow: 8_192,
      maxInputTokens: 7_000,
      maxOutputTokens: 512
    };
    const created = store.upsertDiscoveredModel(managedInput, metadata);
    expect(created).toMatchObject({ status: "created", model: { catalogManaged: true, maxInputTokens: 7_000 } });
    expect(store.upsertDiscoveredModel({
      ...managedInput,
      contextWindow: null,
      maxInputTokens: null,
      maxOutputTokens: 4_096
    }, null).status).toBe("skipped");
    expect(store.getModel(created.model.id)).toMatchObject({
      contextWindow: 8_192,
      maxInputTokens: 7_000,
      catalogMetadata: metadata
    });
    expect(store.updateModel(created.model.id, { enabled: false })?.catalogManaged).toBe(true);
    expect(store.updateModel(created.model.id, { contextWindow: 4_096 })?.catalogManaged).toBe(false);
    expect(store.upsertDiscoveredModel({ ...managedInput, contextWindow: 16_384 }, metadata).status).toBe("skipped");
    expect(store.restoreCatalogModel(created.model.id, { ...managedInput, contextWindow: 16_384 }, metadata))
      .toMatchObject({ catalogManaged: true, contextWindow: 16_384, enabled: false });
    store.close();
  });

  it("migrates v1 data and backfills conversation and generation model fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-v1-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(MIGRATION_V1);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO connections (id, name, protocol, base_url, api_key, secret_headers_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run("connection", "Legacy", "openai-chat", "https://example.test/v1", "", "{}", now, now);
    sqlite.prepare(`
      INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("model", "connection", "legacy-model", "Legacy Model", 2048, 128, "{}", '{"common":{"maxOutputTokens":128,"stopSequences":[]},"protocol":{}}', "manual", 1, now, now);
    sqlite.prepare("UPDATE app_settings SET default_model_id = ? WHERE id = 1").run("model");
    sqlite.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("conversation", "Legacy chat", "", "trim", "", now, now);
    sqlite.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("assistant", "conversation", 1, "assistant", null, "generation", now);
    sqlite.prepare(`
      INSERT INTO generations (id, assistant_message_id, version, status, connection_id, model_id,
        connection_name, protocol, model_key, settings_json, created_at)
      VALUES (?, ?, 1, 'completed', ?, ?, ?, ?, ?, ?, ?)
    `).run("generation", "assistant", "connection", "model", "Legacy", "openai-chat", "legacy-model", '{"common":{"maxOutputTokens":128,"stopSequences":[]},"protocol":{}}', now);
    sqlite.close();

    const store = new Store(path);
    expect((store.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    expect(store.getConversation("conversation")?.modelId).toBe("model");
    expect(store.getConnection("connection")?.providerId).toBe("custom");
    expect(store.getAgent(store.getSettings().defaultAgentId)?.execution.reasoningEffort).toBe("none");
    expect(store.getModel("model")?.capabilities.tools).toBe(true);
    const columns = (store.sqlite.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain("reasoning_effort");
    expect(store.listMessages("conversation")[0]?.generatedModel).toMatchObject({
      modelId: "model",
      displayName: "Legacy Model",
      modelKey: "legacy-model"
    });
    store.close();
  });

  it("adds a custom provider identity to pre-preset connection tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-v27-connections-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new Store(path);
    legacy.sqlite.exec("ALTER TABLE connections DROP COLUMN provider_id; PRAGMA user_version = 27;");
    legacy.sqlite.prepare(`
      INSERT INTO connections (id, name, protocol, base_url, api_key, secret_headers_json, balance_config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-connection", "Legacy", "openai-chat", "https://example.test/v1", "", "{}", "{}", 1, 1);
    legacy.close();

    const migrated = new Store(path);
    expect(migrated.getConnection("legacy-connection")?.providerId).toBe("custom");
    expect((migrated.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    migrated.close();
  });

  it("migrates v13 balance storage and safely repairs Anthropic usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-v13-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const store = new Store(path);
    const anthropic = store.createConnection({
      name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://anthropic.test/v1",
      secretHeaders: {}
    });
    const openai = store.createConnection({
      name: "OpenAI", protocol: "openai-chat", baseUrl: "https://openai.test/v1", secretHeaders: {}
    });
    const model = store.createModel({
      connectionId: anthropic.id, modelKey: "claude", displayName: "Claude", contextWindow: 4096,
      maxOutputTokens: 256,
      capabilities: {
        imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false,
        adaptiveThinking: false, manualThinking: false
      },
      defaultSettings: { common: { maxOutputTokens: 256, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    updateDefaultAgentExecution(store, { modelId: model.id });
    const started = store.startConversation({ text: "legacy", modelId: model.id });
    store.sqlite.prepare("UPDATE generations SET usage_json = ? WHERE id = ?")
      .run('{"inputTokens":7,"cachedInputTokens":5,"outputTokens":3,"totalTokens":10}', started.generation.generationId);
    const anthropicSummary = store.saveSummary({
      conversationId: started.conversation.id, throughOrdinal: 1, fingerprint: "anthropic", text: "summary",
      connectionId: anthropic.id, modelKey: "claude",
      usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 4, totalTokens: 15 }
    });
    const openaiSummary = store.saveSummary({
      conversationId: started.conversation.id, throughOrdinal: 2, fingerprint: "openai", text: "summary",
      connectionId: openai.id, modelKey: "gpt",
      usage: { inputTokens: 9, cachedInputTokens: 3, outputTokens: 1, totalTokens: 10 }
    });
    const incompleteSummary = store.saveSummary({
      conversationId: started.conversation.id, throughOrdinal: 3, fingerprint: "incomplete", text: "summary",
      connectionId: anthropic.id, modelKey: "claude", usage: { cachedInputTokens: 8, outputTokens: 2 }
    });
    store.sqlite.exec("ALTER TABLE connections DROP COLUMN balance_config_json; PRAGMA user_version = 13;");
    store.close();

    const migrated = new Store(path);
    expect((migrated.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    expect((migrated.sqlite.prepare("PRAGMA table_info(connections)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("balance_config_json");
    expect(migrated.getConnection(anthropic.id)?.balanceConfig).toBeUndefined();
    expect(migrated.getGeneration(started.generation.generationId)?.usage).toEqual({
      inputTokens: 12, cachedInputTokens: 5, outputTokens: 3, totalTokens: 15
    });
    const usage = (id: string) => JSON.parse(String((migrated.sqlite.prepare(
      "SELECT usage_json FROM context_summaries WHERE id = ?"
    ).get(id) as { usage_json: string }).usage_json));
    expect(usage(anthropicSummary)).toEqual({ inputTokens: 13, cachedInputTokens: 2, outputTokens: 4, totalTokens: 17 });
    expect(usage(openaiSummary)).toEqual({ inputTokens: 9, cachedInputTokens: 3, outputTokens: 1, totalTokens: 10 });
    expect(usage(incompleteSummary)).toEqual({ cachedInputTokens: 8, outputTokens: 2 });
    migrated.close();
  });

  it("migrates v14 Skill source metadata and backfills bundled ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-v14-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const store = new Store(path);
    const insert = store.sqlite.prepare(`
      INSERT INTO skill_installations (id, name, description, source_path, active_revision, state, error,
        required_tools_json, recommended_approvals_json, bundled, source_kind, compatibility, installed_at, updated_at)
      VALUES (?, ?, '', ?, 'revision', 'loaded', NULL, '[]', '{}', ?, ?, NULL, 1, 1)
    `);
    insert.run("bundled-skill", "Bundled", "/bundled", 1, "bundled");
    insert.run("manual-skill", "Manual", "/manual", 0, "manual");
    store.sqlite.exec(`
      ALTER TABLE skill_installations DROP COLUMN compatibility;
      ALTER TABLE skill_installations DROP COLUMN source_kind;
      PRAGMA user_version = 14;
    `);
    store.close();

    const migrated = new Store(path);
    expect((migrated.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    const rows = migrated.sqlite.prepare(
      "SELECT id, source_kind, compatibility, bundled FROM skill_installations ORDER BY id"
    ).all();
    expect(rows).toEqual([
      { id: "bundled-skill", source_kind: "bundled", compatibility: null, bundled: 1 },
      { id: "manual-skill", source_kind: "manual", compatibility: null, bundled: 0 }
    ]);
    migrated.close();
  });

  it("repairs the numeric tools flag produced by the v9 hot migration", () => {
    const store = createStore();
    const { model } = seedModel(store);
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.sqlite.prepare("UPDATE models SET capabilities_json = json_set(capabilities_json, '$.tools', 1) WHERE id = ?").run(model.id);
    store.sqlite.exec("PRAGMA user_version = 9");
    store.close();
    const repaired = new Store(path);
    expect(repaired.getModel(model.id)?.capabilities.tools).toBe(true);
    repaired.close();
  });

  it("enforces the global reasoning_effort CHECK constraint at the SQLite layer", () => {
    const store = createStore();
    expect(() => store.sqlite.prepare(
      "UPDATE app_settings SET reasoning_effort = 'bogus' WHERE id = 1"
    ).run()).toThrow(/CHECK/i);
    store.close();
  });

  it("keeps a conversation reasoning override stable across sends and retries", () => {
    const store = createStore();
    const { model } = seedModel(store);
    store.updateModel(model.id, {
      capabilities: { ...model.capabilities, reasoning: true },
      defaultSettings: { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {} }
    });
    updateDefaultAgentExecution(store, { reasoningEffort: "high" });
    const started = store.startConversation({ text: "hi", agentId: store.getSettings().defaultAgentId, greetingIndex: 0, executionOverrides: { modelId: model.id, reasoningEffort: "high" } });
    expect(store.getGeneration(started.generation.generationId)?.settings.reasoningEffort).toBe("high");

    updateDefaultAgentExecution(store, { reasoningEffort: "xhigh" });
    const second = store.createMessageGeneration(started.conversation.id, "继续");
    expect(store.getGeneration(second.generationId)?.settings.reasoningEffort).toBe("high");

    updateDefaultAgentExecution(store, { reasoningEffort: "max" });
    const retry = store.createRetryGeneration(second.assistantMessageId);
    expect(store.getGeneration(retry.generationId)?.settings.reasoningEffort).toBe("high");
    expect(store.getGeneration(started.generation.generationId)?.settings.reasoningEffort).toBe("high");
    store.close();
  });

  it("rejects reasoning effort atomically when the model lacks reasoning capability", () => {
    const store = createStore();
    const { model } = seedModel(store); // seedModel has reasoning: false
    updateDefaultAgentExecution(store, { reasoningEffort: "high" });
    expect(() => store.startConversation({ text: "hi", modelId: model.id }))
      .toThrow(/不支持推理/);
    expect(store.listConversations()).toHaveLength(0);
    store.close();
  });

  it("rejects anthropic manual thinking when maxOutputTokens is too small", () => {
    const store = createStore();
    const anthropicConnection = store.createConnection({
      name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://x.test/v1", apiKey: "k", secretHeaders: {}
    });
    const model = store.createModel({
      connectionId: anthropicConnection.id,
      modelKey: "claude-tiny",
      displayName: "Claude Tiny",
      contextWindow: 4096,
      maxOutputTokens: 1024,
      capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
      defaultSettings: { common: { maxOutputTokens: 1024, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    updateDefaultAgentExecution(store, { reasoningEffort: "low" });
    expect(() => store.startConversation({ text: "hi", modelId: model.id }))
      .toThrow(/输出上限过低/);
    expect(store.listConversations()).toHaveLength(0);
    updateDefaultAgentExecution(store, { reasoningEffort: "none" });
    const ok = store.startConversation({ text: "hi", modelId: model.id });
    expect(ok.generation.generationId).toBeTruthy();
    store.close();
  });

  it("rejects anthropic manual thinking when the effective defaultSettings ceiling is <= 1024", () => {
    const store = createStore();
    const anthropicConnection = store.createConnection({
      name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://x.test/v1", apiKey: "k", secretHeaders: {}
    });
    // Model row ceiling is 4096, but the effective defaultSettings.common
    // only leaves 1024 — the value the provider actually receives.
    const model = store.createModel({
      connectionId: anthropicConnection.id,
      modelKey: "claude-capped",
      displayName: "Claude Capped",
      contextWindow: 4096,
      maxOutputTokens: 4096,
      capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
      defaultSettings: { common: { maxOutputTokens: 1024, stopSequences: [] }, protocol: { thinkingBudgetTokens: 1024 } },
      enabled: true
    });
    updateDefaultAgentExecution(store, { reasoningEffort: "low" });
    expect(() => store.startConversation({ text: "hi", modelId: model.id }))
      .toThrow(/输出上限过低/);
    expect(store.listConversations()).toHaveLength(0);
    // Raising the effective default ceiling unblocks the same model row.
    store.updateModel(model.id, {
      defaultSettings: {
        common: { maxOutputTokens: 4096, stopSequences: [] },
        protocol: { thinkingBudgetTokens: 1024 }
      }
    });
    const ok = store.startConversation({ text: "hi", modelId: model.id });
    expect(ok.generation.generationId).toBeTruthy();
    const generation = store.getGeneration(ok.generation.generationId);
    expect(generation?.settings.common.maxOutputTokens).toBe(4096);
    expect(generation?.settings.resolvedThinkingBudgetTokens).toBe(1024);
    store.close();
  });

  it("clamps effective common.maxOutputTokens to the model row ceiling on the server side", () => {
    const store = createStore();
    const openaiConnection = store.createConnection({
      name: "OpenAI", protocol: "openai-chat", baseUrl: "https://x.test/v1", apiKey: "k", secretHeaders: {}
    });
    const model = store.createModel({
      connectionId: openaiConnection.id,
      modelKey: "capped-model",
      displayName: "Capped Model",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
      defaultSettings: { common: { maxOutputTokens: 1_000_000, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    const started = store.startConversation({ text: "hi", modelId: model.id });
    const generation = store.getGeneration(started.generation.generationId);
    // Non-Web clients can write defaults beyond the model ceiling; the
    // effective snapshot must reflect the provider-visible clamp.
    expect(generation?.settings.common.maxOutputTokens).toBe(4096);
    store.close();
  });

  it("covers connection and model CRUD boundaries while keeping secrets out of DTOs", () => {
    const store = createStore();
    const first = store.createConnection({
      name: "Zulu", providerId: "openai", protocol: "openai-chat", baseUrl: "https://old.test/v1",
      apiKey: "old-key", secretHeaders: { Authorization: "secret", "X-Key": "value" },
      balanceConfig: { enabled: true, apiPath: "/account/balance", resultExpression: "data.amount" }
    });
    const second = store.createConnection({
      name: "alpha", protocol: "anthropic-messages", baseUrl: "https://anthropic.test/v1",
      secretHeaders: {}
    });
    expect(store.listConnections().map((item) => item.name)).toEqual(["alpha", "Zulu"]);
    expect(first).toMatchObject({
      providerId: "openai",
      hasApiKey: true,
      secretHeaderNames: ["Authorization", "X-Key"],
      balanceConfig: { enabled: true, apiPath: "/account/balance", resultExpression: "data.amount" }
    });
    expect(second.balanceConfig).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("old-key");
    expect(JSON.stringify(first)).not.toContain("\"Authorization\":\"secret\"");
    expect(store.updateConnection("missing", { name: "none" })).toBeUndefined();
    expect(store.updateConnection(first.id, {
      name: "Updated", apiKey: "", secretHeaders: { New: "hidden" },
      balanceConfig: { enabled: false, apiPath: "/next", resultExpression: "credits" }
    })).toMatchObject({
      name: "Updated", hasApiKey: false, secretHeaderNames: ["New"],
      balanceConfig: { enabled: false, apiPath: "/next", resultExpression: "credits" }
    });
    expect(store.getConnection(first.id)).toMatchObject({ apiKey: "", secretHeaders: { New: "hidden" } });

    const settings = { common: { maxOutputTokens: 64, stopSequences: [] }, protocol: {} };
    const input = {
      connectionId: first.id, modelKey: "same", displayName: "Original", contextWindow: 1024,
      maxOutputTokens: 64, capabilities: {
        imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false,
        adaptiveThinking: false, manualThinking: false
      }, defaultSettings: settings, enabled: true
    };
    const model = store.createModel(input);
    const discovered = store.createModel({ ...input, displayName: "Discovered rename" }, "discovered");
    expect(discovered.id).toBe(model.id);
    expect(discovered.displayName).toBe("Discovered rename");
    expect(store.listModels(first.id)).toHaveLength(1);
    expect(store.updateModel("missing", { enabled: false })).toBeUndefined();
    expect(store.updateModel(model.id, { contextWindow: null, modelKey: "renamed" }))
      .toMatchObject({ contextWindow: null, modelKey: "renamed" });
    updateDefaultAgentExecution(store, { modelId: model.id });
    expect(store.deleteConnection("missing")).toBe(false);
    expect(store.deleteConnection(first.id)).toBe(true);
    expect(store.getModel(model.id)).toBeUndefined();
    expect(store.getSettings()).not.toHaveProperty("defaultModelId");
    expect(store.deleteConnection(second.id)).toBe(true);
    store.close();
  });

  it("uses the conversation's current model and rejects missing or disabled choices atomically", () => {
    const store = createStore();
    const { connection, model, settings } = seedModel(store);
    const other = store.createModel({
      connectionId: connection.id, modelKey: "other", displayName: "Other", contextWindow: 4096,
      maxOutputTokens: 256, capabilities: model.capabilities,
      defaultSettings: { ...settings, common: { ...settings.common, maxOutputTokens: 256 } }, enabled: true
    });
    const conversation = store.createConversation({ systemPrompt: "" });
    expect(store.updateConversation("missing", { title: "x" })).toBeUndefined();
    expect(() => store.updateConversation(conversation.id, { modelId: "00000000-0000-4000-8000-000000000099" }))
      .toThrow("模型不存在");
    store.updateConversation(conversation.id, { modelId: null });
    expect(() => store.createMessageGeneration(conversation.id, "no model")).toThrow("选择模型");
    expect(() => store.createMessageGeneration("missing", "no conversation")).toThrow("会话不存在");
    store.updateConversation(conversation.id, { modelId: other.id });
    const generated = store.createMessageGeneration(conversation.id, "with other");
    expect(store.getGeneration(generated.generationId)).toMatchObject({ modelKey: "other" });
    store.updateModel(other.id, { enabled: false });
    expect(store.getConversation(conversation.id)?.modelId).toBe(other.id);
    expect(() => store.updateConversation(conversation.id, { modelId: other.id })).toThrow("模型已停用");
    expect(() => store.createRetryGeneration("missing")).toThrow("助手消息不存在");
    expect(store.deleteConversation("missing")).toBe(false);
    expect(store.deleteConversation(conversation.id)).toBe(true);
    store.close();
  });

  it("enforces active-generation ownership and exposes all busy states", () => {
    const store = createStore();
    seedModel(store);
    const one = store.createConversation({ systemPrompt: "" });
    const two = store.createConversation({ systemPrompt: "" });
    const first = store.createMessageGeneration(one.id, "one");
    const foreign = store.createMessageGeneration(two.id, "two");
    expect(store.conversationIdForMessage(first.assistantMessageId)).toBe(one.id);
    expect(store.conversationIdForMessage("missing")).toBeUndefined();
    expect(store.selectGeneration(first.assistantMessageId, foreign.generationId)).toBe(false);
    expect(store.selectGeneration("missing", first.generationId)).toBe(false);
    expect(store.isConversationBusy(one.id)).toBe(true);
    store.setGenerationRunning(first.generationId);
    expect(store.getGeneration(first.generationId)?.status).toBe("running");
    expect(store.isConversationBusy(one.id)).toBe(true);
    store.setGenerationWaitingApproval(first.generationId);
    expect(store.getGeneration(first.generationId)?.status).toBe("waiting-approval");
    expect(store.isConversationBusy(one.id)).toBe(true);
    store.finishGeneration(first.generationId, "completed", { stopReason: "stop" });
    expect(store.isConversationBusy(one.id)).toBe(false);
    store.close();
  });

  it("stores approval transitions, step context, blocks, usage, results, and errors", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "run tools");
    const pending = store.upsertToolCall(created.generationId, { id: "call-1", name: "first", arguments: "{}" }, 0, 0, true);
    expect(pending).toMatchObject({ approvalState: "pending", requiresApproval: true });
    expect(store.generationIdForToolCall("call-1")).toBe(created.generationId);
    expect(store.generationIdForToolCall("missing")).toBeUndefined();
    expect(store.updateToolCall("missing", { approvalState: "approved" })).toBeUndefined();
    store.updateToolCall("call-1", { approvalState: "approved" });
    store.updateToolCall("call-1", { approvalState: "running", startedAt: 10 });
    store.updateToolCall("call-1", { approvalState: "completed", output: "result", completedAt: 20 });
    store.upsertToolCall(created.generationId, { id: "call-2", name: "second", arguments: "{bad" }, 1, 1, false);
    store.updateToolCall("call-2", { approvalState: "failed", error: "failure", startedAt: 30, completedAt: 40 });
    store.setGenerationStepContext(created.generationId, 0, [{ type: "reasoning", id: "r0" }]);
    store.setGenerationStepContext(created.generationId, 0, [{ type: "reasoning", id: "r1" }]);
    store.updateGenerationBlock(created.generationId, 1, "text", "draft", false, { raw: 1 });
    store.updateGenerationBlock(created.generationId, 1, "text", "final", true, { raw: 2 });
    store.updateGenerationBlock(created.generationId, 1001, "refusal", "cannot", true);
    store.updateGenerationUsage(created.generationId, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    store.setGenerationContext(created.generationId, {
      policy: "trim", omittedMessages: 2, estimatedInputTokens: 10, summaryUsed: false
    });
    store.setProviderContext(created.generationId, [{ encrypted: "opaque" }]);
    store.finishGeneration(created.generationId, "failed", { code: "provider_error", message: "failed", stopReason: "error" });

    expect(store.listToolCalls(created.generationId)).toEqual([
      expect.objectContaining({ id: "call-1", approvalState: "completed", output: "result", startedAt: 10, completedAt: 20 }),
      expect.objectContaining({ id: "call-2", approvalState: "failed", error: "failure" })
    ]);
    expect(store.currentGenerationMessages(created.generationId)).toEqual([
      expect.objectContaining({
        role: "assistant", text: "final", providerPayload: [{ type: "reasoning", id: "r1" }],
        toolCalls: [{ id: "call-1", name: "first", arguments: "{}" }]
      }),
      { role: "tool", text: "", toolResults: [{ callId: "call-1", name: "first", content: "result" }] },
      expect.objectContaining({ role: "assistant", text: "cannot", toolCalls: [{ id: "call-2", name: "second", arguments: "{bad" }] }),
      { role: "tool", text: "", toolResults: [{ callId: "call-2", name: "second", content: JSON.stringify({ error: "failure" }), isError: true }] }
    ]);
    expect(store.getGeneration(created.generationId)).toMatchObject({
      status: "failed", stopReason: "error", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      context: { policy: "trim", omittedMessages: 2 }, error: { code: "provider_error", message: "failed" },
      blocks: [expect.objectContaining({ index: 1, content: "final", complete: true }), expect.objectContaining({ index: 1001, type: "refusal" })]
    });
    expect(store.currentGenerationMessages("missing")).toEqual([]);
    store.close();
  });

  it("persists tool, MCP, and memory settings while redacting their secrets", () => {
    const store = createStore();
    expect(store.getToolSettings()).toMatchObject({
      enabled: {}, workspaceShellEnabled: true
    });
    expect(store.updateToolSettings({
      enabled: { fetch_url: false },
      workspaceShellEnabled: true
    })).toMatchObject({
      enabled: { fetch_url: false }, workspaceShellEnabled: true
    });
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    expect(agent.searchApiKeyConfigured).toBe(false);
    store.updateAgent(agent.id, {
      execution: { ...agent.execution, search: { provider: "tavily", baseUrl: "https://api.tavily.com" } }
    });
    store.updateAgentSearchSecret(agent.id, "tavily", "search-secret");
    expect(store.getAgentSearchSecret(agent.id, "tavily")).toBe("search-secret");
    expect(store.getAgent(agent.id)).toMatchObject({ searchApiKeyConfigured: true });
    expect(JSON.stringify(store.getAgent(agent.id))).not.toContain("search-secret");
    store.updateAgentSearchSecret(agent.id, "tavily", "");
    expect(store.getAgent(agent.id)?.searchApiKeyConfigured).toBe(false);

    const server = store.createMcpServer({
      name: "Server", url: "https://mcp.test", headers: { Authorization: "Bearer secret" }, enabled: true
    });
    expect(server).toMatchObject({ name: "Server", headerNames: ["Authorization"], lastError: null });
    expect(JSON.stringify(server)).not.toContain("Bearer secret");
    expect(store.getMcpServer(server.id)?.headers).toEqual({ Authorization: "Bearer secret" });
    store.setMcpServerError(server.id, "offline");
    expect(store.listMcpServers()[0]?.lastError).toBe("offline");
    expect(store.updateMcpServer(server.id, { name: "Renamed", enabled: false })).toMatchObject({
      name: "Renamed", enabled: false, lastError: null
    });
    expect(store.updateMcpServer("missing", { name: "none" })).toBeUndefined();
    expect(store.deleteMcpServer("missing")).toBe(false);
    expect(store.deleteMcpServer(server.id)).toBe(true);

    const first = store.createMemory("first");
    const second = store.createMemory("second");
    expect(store.listMemories().map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.updateMemory(first.id, "updated").content).toBe("updated");
    store.deleteMemory(second.id);
    expect(() => store.updateMemory(999, "missing")).toThrow("不存在");
    expect(() => store.deleteMemory(999)).toThrow("不存在");
    store.close();
  });

  it("migrates legacy global search settings into every Agent", () => {
    const store = createStore();
    const agentId = store.getSettings().defaultAgentId;
    const agent = store.getAgent(agentId)!;
    const legacyExecution = { ...agent.execution } as Record<string, unknown>;
    delete legacyExecution.search;
    store.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyExecution), agentId);
    store.sqlite.prepare("UPDATE tool_settings SET search_base_url = ?, search_api_key = ? WHERE id = 1")
      .run("https://legacy-search.test", "legacy-secret");
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.sqlite.exec("PRAGMA user_version = 26");
    store.close();

    const migrated = new Store(path);
    expect(migrated.getAgent(agentId)).toMatchObject({
      searchApiKeyConfigured: true,
      execution: { search: { provider: "searxng", baseUrl: "https://legacy-search.test" } }
    });
    expect(migrated.getAgentSearchSecret(agentId, "searxng")).toBe("legacy-secret");
    expect(migrated.getToolSettings()).not.toHaveProperty("search");
    migrated.close();
  });

  it("returns provider-aware context and literal chat-search matches", () => {
    const store = createStore();
    const { connection } = seedModel(store);
    const conversation = store.createConversation({ title: "Search", systemPrompt: "" });
    const first = store.createMessageGeneration(conversation.id, "literal 100%_value");
    store.updateGenerationBlock(first.generationId, 1, "reasoning", "hidden", true);
    store.updateGenerationBlock(first.generationId, 2, "text", "assistant content", true);
    store.setProviderContext(first.generationId, [{ id: "provider" }]);
    store.upsertToolCall(first.generationId, { id: "ctx-call", name: "fn", arguments: "{}" }, 0, 0, false);
    store.updateToolCall("ctx-call", { approvalState: "failed", error: "tool failed" });
    const latest = store.createMessageGeneration(conversation.id, "latest");
    expect(store.contextMessages(conversation.id, "missing")).toEqual([]);
    expect(store.contextMessages(conversation.id, latest.assistantMessageId)).toEqual([
      expect.objectContaining({ role: "user", text: "literal 100%_value" }),
      expect.objectContaining({
        role: "assistant", text: "assistant content",
        steps: [expect.objectContaining({ role: "assistant", providerConnectionId: connection.id,
          providerPayload: [{ id: "provider" }], toolCalls: [{ id: "ctx-call", name: "fn", arguments: "{}" }] }),
          expect.objectContaining({ role: "tool", toolResults: [{ callId: "ctx-call", name: "fn", content: JSON.stringify({ error: "tool failed" }), isError: true }] })]
      }),
      expect.objectContaining({ role: "user", text: "latest" })
    ]);
    expect(store.searchChats("100%_value", 10)).toHaveLength(1);
    expect(store.searchChats("100Xvalue", 10)).toEqual([]);
    expect(store.recentChats(1)).toEqual([expect.objectContaining({ id: conversation.id })]);
    store.close();
  });

  it("marks unfinished generations interrupted on restart and rejects future database versions", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const queued = store.createMessageGeneration(conversation.id, "queued");
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();
    const reopened = new Store(path);
    recoverInterruptedWork(reopened.sqlite);
    expect(reopened.getGeneration(queued.generationId)?.status).toBe("interrupted");
    expect(reopened.getGeneration(queued.generationId)?.completedAt).not.toBeNull();
    reopened.sqlite.exec("PRAGMA user_version = 999");
    reopened.close();
    expect(() => new Store(path)).toThrow("高于当前服务支持的版本");
  });

  it("migrates v12 terminal generations to complete tool result context", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const failed = store.createMessageGeneration(conversation.id, "failed with incomplete tools");
    store.upsertToolCall(failed.generationId, { id: "legacy-auto", name: "read", arguments: "{}" }, 0, 0, false);
    store.upsertToolCall(failed.generationId, { id: "legacy-pending", name: "write", arguments: "{}" }, 1, 0, true);
    store.sqlite.prepare(`
      UPDATE generations SET status = 'failed', error_code = 'provider_error', error_message = 'failed', completed_at = ?
      WHERE id = ?
    `).run(Date.now(), failed.generationId);
    store.sqlite.exec("PRAGMA user_version = 12");
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();

    const repaired = new Store(path);
    expect((repaired.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(40);
    const calls = repaired.listToolCalls(failed.generationId);
    expect(calls).toEqual([
      expect.objectContaining({ id: "legacy-auto", approvalState: "failed", error: expect.stringContaining("Generation ended") }),
      expect.objectContaining({ id: "legacy-pending", approvalState: "denied", output: expect.stringContaining("denied"), error: null })
    ]);
    expect(calls.every((call) => call.output !== null || call.error !== null)).toBe(true);
    expect(repaired.currentGenerationMessages(failed.generationId).at(-1)).toMatchObject({
      role: "tool",
      toolResults: [
        expect.objectContaining({ callId: "legacy-auto", isError: true }),
        expect.objectContaining({ callId: "legacy-pending" })
      ]
    });
    const next = repaired.createMessageGeneration(conversation.id, "next");
    expect(repaired.contextMessages(conversation.id, next.assistantMessageId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        steps: expect.arrayContaining([expect.objectContaining({ role: "tool", toolResults: [
          expect.objectContaining({ callId: "legacy-auto", isError: true }),
          expect.objectContaining({ callId: "legacy-pending" })
        ] })])
      })
    ]));
    repaired.close();
  });

  it("settles incomplete calls when startup interrupts an active generation", () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const active = store.createMessageGeneration(conversation.id, "interrupted tools");
    store.setGenerationRunning(active.generationId);
    store.upsertToolCall(active.generationId, { id: "running-call", name: "read", arguments: "{}" }, 0, 0, false);
    store.updateToolCall("running-call", { approvalState: "running", startedAt: Date.now() });
    store.upsertToolCall(active.generationId, { id: "not-started", name: "read", arguments: "{}" }, 1, 0, false);
    const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
    store.close();

    const reopened = new Store(path);
    recoverInterruptedWork(reopened.sqlite);
    expect(reopened.getGeneration(active.generationId)?.status).toBe("interrupted");
    expect(reopened.listToolCalls(active.generationId)).toEqual([
      expect.objectContaining({ id: "running-call", approvalState: "failed", error: expect.stringContaining("interrupted") }),
      expect.objectContaining({ id: "not-started", approvalState: "failed", error: expect.stringContaining("interrupted") })
    ]);
    reopened.close();
  });
});
