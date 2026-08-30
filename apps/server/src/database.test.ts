import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_V1, resolveManualThinkingBudget, Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

const dirs: string[] = [];
afterEach(() => {
  cleanupStores();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  it("inserts xhigh between the existing manual Thinking budget tiers", () => {
    expect(resolveManualThinkingBudget("high", 10_000)).toBe(5_500);
    expect(resolveManualThinkingBudget("xhigh", 10_000)).toBe(6_750);
    expect(resolveManualThinkingBudget("max", 10_000)).toBe(8_000);
    expect(resolveManualThinkingBudget("xhigh", 10_000, 2_000)).toBe(4_400);
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
    expect(store.getConversation(conversation.id)?.modelId).toBeNull();
    store.close();
  });

  it("starts a conversation and its first generation atomically", () => {
    const store = createStore();
    const { model } = seedModel(store);
    store.updateSettings({ defaultSystemPrompt: "server system", defaultContextPolicy: "full" });

    const started = store.startConversation({
      text: "  第一条消息  ",
      modelId: model.id,
      contextPolicy: "summarize"
    });

    expect(started.conversation).toMatchObject({
      title: "第一条消息",
      systemPrompt: "server system",
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

  it("migrates v1 data and backfills conversation and generation model fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-v1-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(MIGRATION_V1);
    const now = Date.now();
    sqlite.prepare("INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
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
    expect((store.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    expect(store.getConversation("conversation")?.modelId).toBe("model");
    expect(store.getSettings().reasoningEffort).toBe("none");
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

  it("uses one global effort across conversations, sends, and retries", () => {
    const store = createStore();
    const { model } = seedModel(store);
    store.updateModel(model.id, {
      capabilities: { ...model.capabilities, reasoning: true },
      defaultSettings: { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {} }
    });
    store.updateSettings({ reasoningEffort: "high" });
    const started = store.startConversation({ text: "hi", modelId: model.id });
    expect(store.getGeneration(started.generation.generationId)?.settings.reasoningEffort).toBe("high");

    store.updateSettings({ reasoningEffort: "xhigh" });
    const second = store.createMessageGeneration(started.conversation.id, "继续");
    expect(store.getGeneration(second.generationId)?.settings.reasoningEffort).toBe("xhigh");

    store.updateSettings({ reasoningEffort: "max" });
    const retry = store.createRetryGeneration(second.assistantMessageId);
    expect(store.getGeneration(retry.generationId)?.settings.reasoningEffort).toBe("max");
    expect(store.getGeneration(started.generation.generationId)?.settings.reasoningEffort).toBe("high");
    store.close();
  });

  it("rejects reasoning effort atomically when the model lacks reasoning capability", () => {
    const store = createStore();
    const { model } = seedModel(store); // seedModel has reasoning: false
    store.updateSettings({ reasoningEffort: "high" });
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
      capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
      defaultSettings: { common: { maxOutputTokens: 1024, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    store.updateSettings({ reasoningEffort: "low" });
    expect(() => store.startConversation({ text: "hi", modelId: model.id }))
      .toThrow(/输出上限过低/);
    expect(store.listConversations()).toHaveLength(0);
    store.updateSettings({ reasoningEffort: "none" });
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
      capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
      defaultSettings: { common: { maxOutputTokens: 1024, stopSequences: [] }, protocol: { thinkingBudgetTokens: 1024 } },
      enabled: true
    });
    store.updateSettings({ reasoningEffort: "low" });
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
      capabilities: { tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
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
});
