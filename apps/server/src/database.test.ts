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
    expect(store.getConversation(conversation.id)?.modelId).toBe(secondModel.id);
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
    expect((store.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
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

  it("keeps a conversation reasoning override stable across sends and retries", () => {
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
    expect(store.getGeneration(second.generationId)?.settings.reasoningEffort).toBe("high");

    store.updateSettings({ reasoningEffort: "max" });
    const retry = store.createRetryGeneration(second.assistantMessageId);
    expect(store.getGeneration(retry.generationId)?.settings.reasoningEffort).toBe("high");
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

  it("covers connection and model CRUD boundaries while keeping secrets out of DTOs", () => {
    const store = createStore();
    const first = store.createConnection({
      name: "Zulu", protocol: "openai-chat", baseUrl: "https://old.test/v1",
      apiKey: "old-key", secretHeaders: { Authorization: "secret", "X-Key": "value" }
    });
    const second = store.createConnection({
      name: "alpha", protocol: "anthropic-messages", baseUrl: "https://anthropic.test/v1",
      secretHeaders: {}
    });
    expect(store.listConnections().map((item) => item.name)).toEqual(["alpha", "Zulu"]);
    expect(first).toMatchObject({ hasApiKey: true, secretHeaderNames: ["Authorization", "X-Key"] });
    expect(JSON.stringify(first)).not.toContain("old-key");
    expect(JSON.stringify(first)).not.toContain("\"Authorization\":\"secret\"");
    expect(store.updateConnection("missing", { name: "none" })).toBeUndefined();
    expect(store.updateConnection(first.id, { name: "Updated", apiKey: "", secretHeaders: { New: "hidden" } }))
      .toMatchObject({ name: "Updated", hasApiKey: false, secretHeaderNames: ["New"] });
    expect(store.getConnection(first.id)).toMatchObject({ apiKey: "", secretHeaders: { New: "hidden" } });

    const settings = { common: { maxOutputTokens: 64, stopSequences: [] }, protocol: {} };
    const input = {
      connectionId: first.id, modelKey: "same", displayName: "Original", contextWindow: 1024,
      maxOutputTokens: 64, capabilities: {
        tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false,
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
    store.updateSettings({ defaultModelId: model.id });
    expect(store.deleteConnection("missing")).toBe(false);
    expect(store.deleteConnection(first.id)).toBe(true);
    expect(store.getModel(model.id)).toBeUndefined();
    expect(store.getSettings().defaultModelId).toBeNull();
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
      enabled: {}, search: { baseUrl: "", hasApiKey: false }, workspaceShellEnabled: true
    });
    expect(store.updateToolSettings({
      enabled: { fetch_url: false }, search: { baseUrl: "https://search.test", apiKey: "search-secret" },
      workspaceShellEnabled: true
    })).toMatchObject({
      enabled: { fetch_url: false }, search: { baseUrl: "https://search.test", hasApiKey: true }, workspaceShellEnabled: true
    });
    expect(JSON.stringify(store.getToolSettings())).not.toContain("search-secret");
    store.updateToolSettings({ search: { baseUrl: "https://new.test" } });
    expect(store.getToolSecrets().searchApiKey).toBe("search-secret");
    store.updateToolSettings({ search: { baseUrl: "", apiKey: "" } });
    expect(store.getToolSettings().search.hasApiKey).toBe(false);

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
        role: "assistant", text: "assistant content", providerConnectionId: connection.id,
        providerPayload: [{ id: "provider" }],
        toolCalls: [{ id: "ctx-call", name: "fn", arguments: "{}" }],
        toolResults: [{ callId: "ctx-call", name: "fn", content: JSON.stringify({ error: "tool failed" }), isError: true }]
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
    expect(reopened.getGeneration(queued.generationId)?.status).toBe("interrupted");
    expect(reopened.getGeneration(queued.generationId)?.completedAt).not.toBeNull();
    reopened.sqlite.exec("PRAGMA user_version = 999");
    reopened.close();
    expect(() => new Store(path)).toThrow("高于当前服务支持的版本");
  });
});
