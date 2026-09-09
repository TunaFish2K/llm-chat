import { updateDefaultAgentExecution } from "./test-helpers";
import { adapterFor, type ProviderAdapter, type ProviderEvent } from "@llm-chat/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, compactConversationContext, ContextError, estimateTokens } from "./context";
import type { Store } from "./database";
import { cleanupStores, createStore as createTestStore, seedModel } from "./test-helpers";

vi.mock("@llm-chat/providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@llm-chat/providers")>(),
  adapterFor: vi.fn()
}));

afterEach(() => {
  vi.mocked(adapterFor).mockReset();
  cleanupStores();
});

function createStore(): Store {
  const store = createTestStore();
  updateDefaultAgentExecution(store, { baseSystemPrompt: "" });
  return store;
}

function completeTurn(store: Store, conversationId: string, user: string, assistant: string) {
  const created = store.createMessageGeneration(conversationId, user);
  store.setGenerationRunning(created.generationId);
  store.updateGenerationBlock(created.generationId, 1, "text", assistant, true);
  store.finishGeneration(created.generationId, "completed", { stopReason: "stop" });
  return created;
}

function summaryAdapter(events: ProviderEvent[]): ProviderAdapter {
  return {
    protocol: "openai-chat",
    listModels: async () => [],
    async *stream() {
      for (const event of events) yield event;
    }
  };
}

describe("context builder", () => {
  it("uses UTF-8 bytes and fixed message overhead for conservative estimates", () => {
    expect(estimateTokens("", [])).toBe(14);
    expect(estimateTokens("中文测试", [])).toBeGreaterThan(estimateTokens("test", []));
    expect(estimateTokens("", [{ role: "user", text: "中文测试" }])).toBeGreaterThan(4);
    expect(estimateTokens("", [{ role: "user", text: "a long english sentence" }])).toBeGreaterThan(6);
    expect(estimateTokens("system", [{ role: "user", text: "x" }, { role: "assistant", text: "y" }]))
      .toBeGreaterThan(estimateTokens("", [{ role: "user", text: "xy" }]));
  });

  it("returns full context without requiring a context window", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: null })!;
    const conversation = store.createConversation({ systemPrompt: "system", contextPolicy: "full" });
    completeTurn(store, conversation.id, "question", "answer");
    const latest = store.createMessageGeneration(conversation.id, "latest");
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built).toMatchObject({
      messages: [{ role: "user", text: "question" }, { role: "assistant", text: "answer" }, { role: "user", text: "latest" }],
      metadata: { policy: "full", omittedMessages: 0, summaryUsed: false }
    });
    expect(built.systemPrompt).toContain("名称：默认助手");
    expect(built.metadata.estimatedInputTokens).toBe(estimateTokens(built.systemPrompt, built.messages));
    store.close();
  });

  it("exposes ordinary attachments as escaped sandbox metadata without sending their bytes", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const asset = store.createFileAsset({
      sha256: "a".repeat(64),
      fileName: "notes & instructions.txt",
      mimeType: "text/plain",
      kind: "file",
      byteSize: 17,
      storageKey: "not-read-by-context"
    });
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "full" });
    const latest = store.createMessageGeneration(conversation.id, "请检查附件", [asset.id]);
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, seeded.model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    const text = built.messages.at(-1)?.text ?? "";
    expect(text).toContain('<attached_files trust="untrusted" workspace="attachments">');
    expect(text).toContain('name="notes &amp; instructions.txt"');
    expect(text).toContain(`path="incoming/${latest.userMessageId}/${asset.id}-notes &amp; instructions.txt"`);
    expect(text).not.toContain("not-read-by-context");
    expect(built.messages.at(-1)?.images).toBeUndefined();
    store.close();
  });

  it("returns unchanged trim context when it fits", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "trim" });
    const latest = store.createMessageGeneration(conversation.id, "latest");
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, seeded.model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built.metadata).toMatchObject({ policy: "trim", omittedMessages: 0, summaryUsed: false });
    expect(built.messages).toEqual([{ role: "user", text: "latest" }]);
    store.close();
  });

  it("applies Agent-owned prompt regex without changing stored message text", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    store.updateAgent(agent.id, {
      roleplay: {
        ...agent.roleplay,
        enabled: true,
        regexScripts: [{
          id: "redact", name: "Redact", enabled: true, pattern: "token-[0-9]+", replacement: "token-[hidden]",
          flags: "gu", scopes: ["user_prompt"], runOnEdit: false, importWarning: null
        }]
      }
    });
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "full" });
    const latest = store.createMessageGeneration(conversation.id, "use token-1234");
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, seeded.model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built.messages.at(-1)?.text).toBe("use token-[hidden]");
    expect(store.listMessages(conversation.id)[0]?.text).toBe("use token-1234");
    store.close();
  });

  it("trims complete old turns, including tool results, while preserving the latest user message", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "trim" });
    const first = completeTurn(store, conversation.id, "old question".repeat(20), "old answer".repeat(20));
    store.upsertToolCall(first.generationId, { id: "call", name: "lookup", arguments: "{}" }, 0, 0, false);
    store.updateToolCall("call", { approvalState: "completed", output: "tool output" });
    completeTurn(store, conversation.id, "middle question".repeat(20), "middle answer".repeat(20));
    const latest = store.createMessageGeneration(conversation.id, "latest question");
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built.metadata.omittedMessages).toBeGreaterThan(0);
    expect(built.messages.at(-1)?.text).toBe("latest question");
    expect(built.messages[0]?.role).toBe("user");
    expect(built.messages.some((message) => message.role === "tool")).toBe(false);
    store.close();
  });

  it("reports missing windows, invalid budgets, and an oversized latest message", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "trim" });
    const latest = store.createMessageGeneration(conversation.id, "x".repeat(1_000));
    const record = store.getGenerationRecord(latest.generationId)!;
    const connection = store.getConnection(seeded.connection.id)!;
    const missing = store.updateModel(seeded.model.id, { contextWindow: null })!;
    await expect(buildContext(store, record, missing, connection, new AbortController().signal))
      .rejects.toMatchObject({ code: "context_window_required" });
    const invalid = store.updateModel(seeded.model.id, { contextWindow: 300 })!;
    await expect(buildContext(store, record, invalid, connection, new AbortController().signal))
      .rejects.toMatchObject({ code: "context_budget_invalid" });
    const inputLimited = store.updateModel(seeded.model.id, { contextWindow: 8_192, maxInputTokens: 200 })!;
    await expect(buildContext(store, record, inputLimited, connection, new AbortController().signal))
      .rejects.toMatchObject({ code: "context_budget_invalid" });
    const small = store.updateModel(seeded.model.id, { contextWindow: 512, maxInputTokens: null })!;
    await expect(buildContext(store, record, small, connection, new AbortController().signal))
      .rejects.toMatchObject({ code: "message_too_large" });
    store.close();
  });

  it("summarizes old turns, saves usage, and returns summary metadata", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
    const conversation = store.createConversation({ systemPrompt: "original", contextPolicy: "summarize" });
    completeTurn(store, conversation.id, "old q".repeat(45), "old a".repeat(45));
    completeTurn(store, conversation.id, "middle q".repeat(35), "middle a".repeat(35));
    const latest = store.createMessageGeneration(conversation.id, "latest");
    vi.mocked(adapterFor).mockReturnValue(summaryAdapter([
      { type: "block", index: 1, blockType: "text", content: " compact summary ", complete: true },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
      { type: "complete", stopReason: "stop" }
    ]));
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built.systemPrompt).toContain("[较早对话摘要]\ncompact summary");
    expect(built.messages.at(-1)?.text).toBe("latest");
    expect(built.metadata).toMatchObject({ policy: "summarize", summaryUsed: true });
    expect(built.metadata.omittedMessages).toBeGreaterThan(0);
    expect(store.getLatestSummary(conversation.id)).toMatchObject({ text: "compact summary" });
    const usage = store.sqlite.prepare("SELECT usage_json FROM context_summaries WHERE conversation_id = ?").get(conversation.id) as { usage_json: string };
    expect(JSON.parse(usage.usage_json)).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(adapterFor).toHaveBeenCalledWith("openai-chat");
    store.close();
  });

  it("uses automatic summary with trim fallback and supports manual compaction checkpoints", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "auto" });
    completeTurn(store, conversation.id, "first question".repeat(25), "first answer".repeat(25));
    completeTurn(store, conversation.id, "second question", "second answer");
    completeTurn(store, conversation.id, "third question", "third answer");
    vi.mocked(adapterFor).mockReturnValue(summaryAdapter([
      { type: "block", index: 1, blockType: "text", content: "manual checkpoint", complete: true },
      { type: "usage", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      { type: "complete", stopReason: "stop" }
    ]));

    const checkpoint = await compactConversationContext(store, conversation.id, new AbortController().signal);
    expect(checkpoint).toMatchObject({ text: "manual checkpoint", usage: { totalTokens: 10 } });
    expect(await compactConversationContext(store, conversation.id, new AbortController().signal)).toEqual(checkpoint);

    const latest = store.createMessageGeneration(conversation.id, "latest question");
    vi.mocked(adapterFor).mockReturnValue({
      protocol: "openai-chat", listModels: async () => [],
      async *stream() { throw new Error("summary unavailable"); }
    });
    const built = await buildContext(
      store, store.getGenerationRecord(latest.generationId)!, model,
      store.getConnection(seeded.connection.id)!, new AbortController().signal
    );
    expect(built.metadata).toMatchObject({ policy: "auto" });
    expect(["summary", "trim", "raw"]).toContain(built.metadata.strategy);
    store.close();
  });

  it("does not persist a partial manual checkpoint when compaction fails", async () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "auto" });
    completeTurn(store, conversation.id, "first", "one");
    completeTurn(store, conversation.id, "second", "two");
    completeTurn(store, conversation.id, "third", "three");
    vi.mocked(adapterFor).mockReturnValue({
      protocol: "openai-chat", listModels: async () => [],
      async *stream() { throw new Error("manual summary failed"); }
    });
    await expect(compactConversationContext(store, conversation.id, new AbortController().signal))
      .rejects.toThrow("manual summary failed");
    expect(store.getLatestSummary(conversation.id)).toBeUndefined();
    store.close();
  });

  it("rejects empty and failed summaries without persisting metadata", async () => {
    const setup = () => {
      const store = createStore();
      const seeded = seedModel(store);
      const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
      const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "summarize" });
      completeTurn(store, conversation.id, "old".repeat(150), "answer".repeat(100));
      const latest = store.createMessageGeneration(conversation.id, "latest");
      return { store, seeded, model, conversation, latest };
    };
    const empty = setup();
    vi.mocked(adapterFor).mockReturnValue(summaryAdapter([{ type: "complete", stopReason: "stop" }]));
    await expect(buildContext(
      empty.store, empty.store.getGenerationRecord(empty.latest.generationId)!, empty.model,
      empty.store.getConnection(empty.seeded.connection.id)!, new AbortController().signal
    )).rejects.toMatchObject({ code: "summary_empty" });
    expect(empty.store.getLatestSummary(empty.conversation.id)).toBeUndefined();
    empty.store.close();

    const failed = setup();
    vi.mocked(adapterFor).mockReturnValue({
      protocol: "openai-chat", listModels: async () => [],
      async *stream() { throw new Error("summary failed"); }
    });
    await expect(buildContext(
      failed.store, failed.store.getGenerationRecord(failed.latest.generationId)!, failed.model,
      failed.store.getConnection(failed.seeded.connection.id)!, new AbortController().signal
    )).rejects.toThrow("summary failed");
    expect(failed.store.getLatestSummary(failed.conversation.id)).toBeUndefined();
    failed.store.close();
  });

  it("propagates aborts from summary generation", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "summarize" });
    completeTurn(store, conversation.id, "old".repeat(150), "answer".repeat(100));
    const latest = store.createMessageGeneration(conversation.id, "latest");
    vi.mocked(adapterFor).mockReturnValue({
      protocol: "openai-chat", listModels: async () => [],
      async *stream(request) {
        if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
        yield { type: "complete", stopReason: "stop" } as const;
      }
    });
    const controller = new AbortController();
    controller.abort();
    await expect(buildContext(
      store, store.getGenerationRecord(latest.generationId)!, model,
      store.getConnection(seeded.connection.id)!, controller.signal
    )).rejects.toMatchObject({ name: "AbortError" });
    store.close();
  });

  it("uses stable ContextError codes", () => {
    const error = new ContextError("code", "message");
    expect(error).toMatchObject({ code: "code", message: "message" });
  });
});
