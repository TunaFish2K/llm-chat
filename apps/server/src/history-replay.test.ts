import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFor, prepareMessages, type GenerateRequest, type ProviderEvent } from "@llm-chat/providers";
import { buildContext } from "./context";
import { cleanupStores, createStore, seedModel, updateDefaultAgentExecution } from "./test-helpers";
import { GenerationRunner } from "./generations";
import { VisionService, type PreparedImages } from "./vision";
import { ImageService } from "./images";
import type { ServerTool } from "./tools";

vi.mock("@llm-chat/providers", async (original) => ({ ...await original<typeof import("@llm-chat/providers")>(), adapterFor: vi.fn() }));
afterEach(() => { cleanupStores(); vi.mocked(adapterFor).mockReset(); });
function setup() {
  const store = createStore(); const seeded = seedModel(store);
  const model = store.updateModel(seeded.model.id, { contextWindow: 32768, capabilities: { ...seeded.model.capabilities, imageOutput: true, imageInput: true }, imageProtocol: "openai-images" })!;
  updateDefaultAgentExecution(store, { contextPolicy: "full" });
  const conversation = store.createConversation({ agentId: store.getSettings().defaultAgentId! });
  return { store, model, connection: store.getConnection(seeded.connection.id)!, conversation };
}
function complete(store: ReturnType<typeof createStore>, id: string, text = "answer", index = 1) {
  store.updateGenerationBlock(id, index, "text", text, true);
  store.finishGeneration(id, "completed", { stopReason: "stop" });
}
async function context(f: ReturnType<typeof setup>, id: string, images: PreparedImages = new Map()) {
  return buildContext(f.store, f.store.getGenerationRecord(id)!, f.model, f.connection, new AbortController().signal, images);
}
function request(f: ReturnType<typeof setup>, built: Awaited<ReturnType<typeof context>>): GenerateRequest {
  return { connection: f.connection, modelKey: f.model.modelKey, settings: { ...f.model.defaultSettings, reasoningEffort: "none" }, capabilities: f.model.capabilities,
    messages: built.messages, systemPrompt: built.systemPrompt, signal: new AbortController().signal,
    requestContext: { sessionId: "test", requestId: "test", clientId: "test", userAgent: "test" } };
}

describe("ordered history replay", () => {
  it("keeps failed image tasks visible without poisoning a retried reply's context", async () => {
    const f = setup(); const {store,model,connection,conversation} = f;
    const first = store.createMessageGeneration(conversation.id, "can you draw?");
    for (let i = 0; i < 2; i++) {
      const callId = `image-${i}`;
      store.upsertToolCall(first.generationId, { id: callId, name: "image_generate", arguments: "{}" }, i, 0, false);
      const job = store.createImageGenerationJob({ conversationId: conversation.id, toolCallId: callId, model, connection,
        request: { modelId: model.id, prompt: "beach", operation: "generate", count: 1, referenceAssetIds: [] } });
      store.updateImageGenerationJob(job.id, { status: "failed", error: { code: "image_provider_error", message: "no accounts" } });
      store.updateToolCall(callId, { approvalState: "failed", error: "no accounts", output: '{"error":"no accounts"}' });
    }
    complete(store, first.generationId);
    const retry = store.createRetryGeneration(first.assistantMessageId); complete(store, retry.generationId, "can draw");
    const next = store.createMessageGeneration(conversation.id, "beach");
    const built = await context(f, next.generationId);
    expect(built.messages.map((message) => message.text)).toEqual(["can you draw?", "can draw", "beach"]);
    expect(prepareMessages(request(f, built))).toHaveLength(3);
    expect(store.listImageGenerationJobs(conversation.id)).toHaveLength(2);
    store.selectGeneration(first.assistantMessageId, first.generationId);
    const oldVersion = await context(f, next.generationId);
    expect(oldVersion.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(prepareMessages(request(f, oldVersion))).toHaveLength(4);
  });

  it("replays every tool step and final answer in execution order", async () => {
    const f = setup(); const {store,conversation} = f;
    const first = store.createMessageGeneration(conversation.id, "question");
    for (let index = 0; index < 2; index++) {
      store.updateGenerationBlock(first.generationId, index * 1000 + 1, "text", `before-${index}`, true);
      store.upsertToolCall(first.generationId, { id: `call-${index}`, name: "lookup", arguments: "{}" }, index * 1000, index, false);
      store.updateToolCall(`call-${index}`, { output: `result-${index}`, approvalState: "completed" });
    }
    complete(store, first.generationId, "final", 2001);
    const next = store.createMessageGeneration(conversation.id, "next");
    const built = await context(f, next.generationId);
    expect(built.messages.map((message) => message.toolResults?.[0]?.content ?? message.text)).toEqual([
      "question", "before-0", "result-0", "before-1", "result-1", "final", "next"
    ]);
    expect(prepareMessages(request(f, built))).toHaveLength(7);
  });

  it("isolates repeated provider call IDs and generated images across retries and forks", async () => {
    const f = setup(); const {store,conversation} = f;
    const first = store.createMessageGeneration(conversation.id, "draw");
    const asset = (name: string) => store.createFileAsset({ sha256: name.repeat(64), fileName: `${name}.png`, mimeType: "image/png", kind: "image", byteSize: 1, storageKey: name });
    const oldImage = asset("a"); const newImage = asset("b");
    const oldCall = store.upsertToolCall(first.generationId, { id: "reused", name: "image_generate", arguments: "{}" }, 0, 0, false);
    store.updateToolCall(oldCall.id, { output: "old result", approvalState: "completed" });
    store.attachImageToToolCall(oldCall.id, oldImage.id); complete(store, first.generationId);
    const oldJob = store.createImageGenerationJob({ conversationId: conversation.id, toolCallId: oldCall.id, model: f.model, connection: f.connection,
      request: { modelId: f.model.id, prompt: "old", operation: "generate", count: 1, referenceAssetIds: [] } });
    store.attachImageJobOutputs(oldJob.id, [oldImage.id]);
    const retry = store.createRetryGeneration(first.assistantMessageId);
    const newCall = store.upsertToolCall(retry.generationId, { id: "reused", name: "image_generate", arguments: "{}" }, 0, 0, false);
    expect(newCall.id).not.toBe(oldCall.id);
    store.updateToolCall(newCall.id, { output: "new result", approvalState: "completed" });
    store.attachImageToToolCall(newCall.id, newImage.id); complete(store, retry.generationId);
    const fork = store.forkConversation(conversation.id, { mode: "continue", throughMessageId: first.assistantMessageId });
    const next = store.createMessageGeneration(fork.conversation.id, "next");
    const history = store.contextMessages(fork.conversation.id, next.assistantMessageId);
    expect(history.flatMap((message) => message.images ?? []).map((image) => image.id)).toEqual([newImage.id]);
    expect(store.getToolCall(oldCall.id)?.output).toBe("old result");
    const built = await context(f, next.generationId);
    expect(prepareMessages(request(f, built)).some((message) => message.toolResults?.[0]?.content === "new result")).toBe(true);
  });

  it("does not create an orphan placeholder if image job insertion fails", () => {
    const {store,model,connection,conversation} = setup();
    store.sqlite.exec("CREATE TRIGGER fail_image_job BEFORE INSERT ON image_generation_jobs BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => store.createImageGenerationJob({ conversationId: conversation.id, model, connection,
      request: { modelId: model.id, prompt: "image", operation: "generate", count: 1, referenceAssetIds: [] } })).toThrow();
    expect(store.listMessages(conversation.id)).toEqual([]);
  });

  it.each([null, 1, 2])("shares image limit %s between uploads and tool outputs, with cached descriptions", async (limit) => {
    const f = setup(); const {store,conversation} = f;
    f.model = store.updateModel(f.model.id, { capabilities: { ...f.model.capabilities, maxImageInputs: limit } })!;
    const vision = store.createModel({ ...f.model, modelKey: "vision", displayName: "Vision", imageProtocol: null,
      capabilities: { ...f.model.capabilities, maxImageInputs: null }, enabled: true });
    updateDefaultAgentExecution(store, { visionModelId: vision.id });
    const images = new ImageService(store); await images.initialize();
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
    const upload = await images.importBytes("upload.png", bytes);
    const generated = await images.importBytes("generated.png", bytes);
    const first = store.createMessageGeneration(conversation.id, "draw", [upload.id]);
    store.upsertToolCall(first.generationId, { id: "draw", name: "image_generate", arguments: "{}" }, 0, 0, false);
    store.updateToolCall("draw", { output: "generated", approvalState: "completed" });
    store.attachImageToToolCall("draw", generated.id);
    vi.mocked(adapterFor).mockReturnValue({ protocol: "openai-chat", listModels: async () => [], async *stream() {
      yield { type: "block", index: 1, blockType: "text", content: "cached description", complete: true } as const;
      yield { type: "complete", stopReason: "stop" } as const;
    } });
    const service = new VisionService(store, images);
    const record = store.getGenerationRecord(first.generationId)!;
    const prepared = await service.prepare(record, f.model, new AbortController().signal, () => {});
    const built = await context(f, first.generationId, prepared);
    const messages = prepareMessages(request(f, built));
    expect(messages.flatMap((message) => message.images ?? [])).toHaveLength(limit === 1 ? 1 : 2);
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.images?.[0]?.assetId).toBe(generated.id);
    if (limit === 1) {
      expect(messages[0]?.text).toContain("cached description");
      await service.prepare(record, f.model, new AbortController().signal, () => {});
      expect(adapterFor).toHaveBeenCalledTimes(1);
    }
  });

  it("deduplicates repeated image assets and rejects a missing fallback model", async () => {
    const f = setup(); const {store,conversation} = f;
    f.model = store.updateModel(f.model.id, { capabilities: { ...f.model.capabilities, maxImageInputs: 1 } })!;
    const images = new ImageService(store); await images.initialize();
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
    const image = await images.importBytes("one.png", bytes);
    const first = store.createMessageGeneration(conversation.id, "first", [image.id]); complete(store, first.generationId);
    const next = store.createMessageGeneration(conversation.id, "same", [image.id]);
    const service = new VisionService(store, images);
    const prepared = await service.prepare(store.getGenerationRecord(next.generationId)!, f.model, new AbortController().signal, () => {});
    const built = await context(f, next.generationId, prepared);
    expect(prepareMessages(request(f, built)).flatMap((message) => message.images ?? [])).toHaveLength(1);
    const another = await images.importBytes("two.png", bytes);
    store.attachImageToToolCall(store.upsertToolCall(next.generationId, { id: "new-image", name: "image_generate", arguments: "{}" }, 0, 0, false).id, another.id);
    store.updateToolCall("new-image", { output: "generated", approvalState: "completed" });
    await expect(service.prepare(store.getGenerationRecord(next.generationId)!, f.model, new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: "vision_model_required" });
  });

  it("checks tool growth before the next model call without truncating stored output", async () => {
    const f = setup(); const {store,conversation} = f;
    store.updateModel(f.model.id, { contextWindow: 2048 });
    const first = store.createMessageGeneration(conversation.id, "read");
    const result = "x".repeat(20_000);
    const tool: ServerTool = { definition: { name: "lookup", description: "read", inputSchema: { type: "object" } }, label: "lookup", category: "local", available: true,
      requiresApproval: () => false, execute: async () => result };
    const stream = vi.fn(async function* () {
      yield { type: "tool-call", call: { id: "read", name: "lookup", arguments: "{}" } } as const;
      yield { type: "complete", stopReason: "tool_calls" } as const;
    });
    const runner = new GenerationRunner(store, { buildTools: async () => [tool], memoryPrompt: () => "", stream });
    runner.start(first.generationId);
    await vi.waitFor(() => expect(store.getGeneration(first.generationId)?.status).toBe("failed"));
    expect(store.getGeneration(first.generationId)?.error?.code).toBe("message_too_large");
    expect(store.getToolCall("read")?.output).toBe(result);
    expect(stream).toHaveBeenCalledOnce();
    await runner.close();
  });

  it("summarizes the ordered tool transcript rather than only visible prose", async () => {
    const f = setup(); const {store,conversation} = f;
    f.model = store.updateModel(f.model.id, { contextWindow: 1000 })!;
    updateDefaultAgentExecution(store, { contextPolicy: "summarize" });
    const first = store.createMessageGeneration(conversation.id, "old question");
    store.updateGenerationBlock(first.generationId, 1, "text", "BEFORE_TOOL", true);
    store.upsertToolCall(first.generationId, { id: "summary-tool", name: "lookup", arguments: '{"query":"facts"}' }, 0, 0, false);
    store.updateToolCall("summary-tool", { output: "TOOL_RESULT " + "x".repeat(500), approvalState: "completed" });
    complete(store, first.generationId, "AFTER_TOOL", 1001);
    for (let i = 0; i < 2; i++) {
      const old = store.createMessageGeneration(conversation.id, "q".repeat(600)); complete(store, old.generationId, "a".repeat(600));
    }
    const next = store.createMessageGeneration(conversation.id, "latest");
    const seen: string[] = [];
    vi.mocked(adapterFor).mockReturnValue({ protocol: "openai-chat", listModels: async () => [], async *stream(req) {
      seen.push(req.messages.map((message) => message.text).join(""));
      yield { type: "block", index: 1, blockType: "text", content: "summary", complete: true } as const;
      yield { type: "complete", stopReason: "stop" } as const;
    } });
    const built = await context(f, next.generationId);
    expect(built.metadata.summaryUsed).toBe(true);
    expect(seen[0]).toContain('query');
    expect(seen[0]).toContain('facts');
    const positions = ["BEFORE_TOOL", "lookup", "TOOL_RESULT", "AFTER_TOOL"].map((value) => seen[0]!.indexOf(value));
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("does not execute a tool from an unterminated stream", async () => {
    const {store,conversation} = setup();
    const first = store.createMessageGeneration(conversation.id, "run tool");
    const execute = vi.fn(async () => "done");
    const runner = new GenerationRunner(store, {
      buildTools: async () => [{ definition: { name: "lookup", description: "lookup", inputSchema: { type: "object" } }, label: "lookup", category: "local", available: true, requiresApproval: () => false, execute }],
      stream: async function* () { yield { type: "tool-call", call: { id: "incomplete-call", name: "lookup", arguments: "{}" } } as const; }
    });
    runner.start(first.generationId);
    await vi.waitFor(() => expect(store.getGeneration(first.generationId)?.status).toBe("failed"));
    expect(execute).not.toHaveBeenCalled();
    expect(store.getGeneration(first.generationId)?.error?.code).toBe("provider_stream_incomplete");
    await runner.close();
  });

  it.each([false, true])("runner rejects empty or partial unterminated streams (partial=%s)", async (partial) => {
    const {store,conversation} = setup();
    const first = store.createMessageGeneration(conversation.id, "hello");
    const runner = new GenerationRunner(store, { buildTools: async () => [], stream: async function* () {
      if (partial) yield { type: "block", index: 1, blockType: "text", content: "partial", complete: false } as ProviderEvent;
      yield { type: "usage", usage: { outputTokens: 7 } } as ProviderEvent;
    } });
    runner.start(first.generationId);
    await vi.waitFor(() => expect(store.getGeneration(first.generationId)?.status).toBe("failed"));
    const generation = store.getGeneration(first.generationId)!;
    expect(generation.error?.code).toBe("provider_stream_incomplete");
    expect(generation.usage.outputTokens).toBe(7);
    if (partial) expect(generation.blocks[0]?.content).toBe("partial");
    await runner.close();
  });
});
