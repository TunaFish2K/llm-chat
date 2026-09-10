import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GenerateRequest, ProviderEvent } from "@llm-chat/providers";
import { ProviderError } from "@llm-chat/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextError } from "./context";
import type { Store } from "./database";
import { GenerationRunner, type GenerationRunnerDependencies } from "./generations";
import type { ImageService } from "./images";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import type { ServerTool } from "./tools";
import { ShellError } from "./shell";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanupStores();
});

describe("GenerationRunner lifecycle", () => {
  it("hands off to steer before the next API call, after completing tools, ahead of ordinary queue items", async () => {
    const store = createStore(); const generation = seedGeneration(store);
    const gate = deferred<void>();
    const execute = vi.fn(async () => { await gate.promise; return "finished tool"; });
    const stream = vi.fn(() => events([toolCall("call", "work", "{}"), { type: "complete", stopReason: "tool_calls" }]));
    const runner = makeRunner(store, { buildTools: async () => [serverTool("work", execute)], stream });
    runner.start(generation.generationId);
    await until(() => execute.mock.calls.length > 0);
    store.enqueueMessage(generation.conversationId, "ordinary", []);
    store.enqueueMessage(generation.conversationId, "change direction", [], "steer");
    expect(store.getGeneration(generation.generationId)?.status).toBe("running");
    gate.resolve();
    const result = await terminal(store, generation.generationId);
    expect(result).toMatchObject({ status: "completed", stopReason: "steered" });
    expect(result.toolCalls[0]?.output).toBe("finished tool");
    expect(stream).toHaveBeenCalledTimes(1);
    const next = store.dispatchQueuedMessage(generation.conversationId, () => {});
    expect(store.listMessages(generation.conversationId).find((message) => message.id === next?.userMessageId)?.text).toBe("change direction");
    expect(store.allContextMessages(generation.conversationId)).toEqual(expect.arrayContaining([expect.objectContaining({ text: "change direction" })]));
    expect(store.listQueuedMessages(generation.conversationId).some((item) => item.text === "ordinary" && item.status === "pending")).toBe(true);
  });

  it("guards unknown and terminal generations and starts an active generation only once", async () => {
    const store = createStore();
    const first = seedGeneration(store);
    const gate = deferred<void>();
    const stream = vi.fn((_protocol, request: GenerateRequest) => blockingStream(request, gate.promise));
    const runner = makeRunner(store, { stream });

    expect(() => runner.start("missing")).toThrow("Generation not found");
    runner.start(first.generationId);
    runner.start(first.generationId);
    expect(runner.isConversationActive(first.conversationId)).toBe(true);
    await until(() => stream.mock.calls.length === 1);
    expect(stream).toHaveBeenCalledTimes(1);

    gate.resolve();
    await terminal(store, first.generationId);
    expect(runner.isConversationActive(first.conversationId)).toBe(false);
    expect(runner.cancel(first.generationId)).toBe(false);

    const terminalGeneration = seedGeneration(store);
    store.finishGeneration(terminalGeneration.generationId, "completed", { stopReason: "stop" });
    runner.start(terminalGeneration.generationId);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it.each(["model", "connection"] as const)("fails when the saved %s configuration was deleted", async (kind) => {
    const store = createStore();
    const generation = seedGeneration(store);
    if (kind === "model") vi.spyOn(store, "getModel").mockReturnValue(undefined);
    else vi.spyOn(store, "getConnection").mockReturnValue(undefined);
    const runner = makeRunner(store);

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "configuration_missing", message: "模型或连接已被删除" }
    });
  });

  it("replays ordered latest blocks to late subscribers and removes terminal jobs", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const gate = deferred<void>();
    const runner = makeRunner(store, {
      stream: () => (async function*() {
        yield block(2, "later", false, "reasoning");
        yield block(0, "first", true);
        await gate.promise;
        yield { type: "complete", stopReason: "stop" } satisfies ProviderEvent;
      })()
    });
    runner.start(generation.generationId);
    await until(() => store.getGeneration(generation.generationId)?.status === "running");
    await turn();

    const replayed: Array<{ index: number; content: string }> = [];
    const unsubscribe = runner.subscribe(generation.generationId, (event) => {
      if (event.type === "block-delta") replayed.push({ index: event.block.index, content: event.block.content });
    });
    expect(replayed).toEqual([{ index: 0, content: "first" }, { index: 2, content: "later" }]);
    unsubscribe();
    gate.resolve();

    const result = await terminal(store, generation.generationId);
    expect(result.blocks.map((item) => item.index)).toEqual([0, 2]);
    const late = vi.fn();
    runner.subscribe(generation.generationId, late);
    expect(late).not.toHaveBeenCalled();
  });

  it("passes context, connection, memory prompt, and an empty tool list for a no-tools model", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const model = store.getModel(generation.modelId)!;
    store.updateModel(model.id, { capabilities: { ...model.capabilities, tools: false } });
    const requests: GenerateRequest[] = [];
    const buildTools = vi.fn(async () => { throw new Error("tools should not be built"); });
    const runner = makeRunner(store, {
      buildTools,
      memoryPrompt: () => "memory",
      buildContext: async (_store, _record, _model, _connection, _signal, _images, options) => ({
        systemPrompt: ["system", options?.additionalSystemPrompt].filter(Boolean).join("\n\n"),
        messages: [{ role: "user", text: "prior" }],
        metadata: { policy: "full", omittedMessages: 0, estimatedInputTokens: 7, summaryUsed: false }
      }),
      stream: (_protocol, request) => {
        requests.push(request);
        return events([{ type: "complete", stopReason: "end_turn" }]);
      }
    });

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(buildTools).not.toHaveBeenCalled();
    expect(requests[0]).toMatchObject({
      modelKey: "mock-model",
      systemPrompt: "system\n\nmemory",
      messages: [{ role: "user", text: "prior" }],
      tools: []
    });
    expect(requests[0]?.connection).toMatchObject({
      id: generation.connectionId,
      protocol: "openai-chat",
      apiKey: "key",
      secretHeaders: {}
    });
    expect(result).toMatchObject({ status: "completed", stopReason: "end_turn", context: { policy: "full" } });
  });

  it("flushes blocks, accumulates usage, and persists provider context across tool steps", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const setProviderContext = vi.spyOn(store, "setProviderContext");
    const setStepContext = vi.spyOn(store, "setGenerationStepContext");
    const requests: GenerateRequest[] = [];
    const execute = vi.fn(async () => "tool output");
    const tool = serverTool("automatic", execute);
    const scripts: ProviderEvent[][] = [
      [
        block(1, "draft", false), block(1, "final", true),
        { type: "provider-context", payload: { response: "one" } },
        { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        toolCall("call-auto", "automatic", "{\"value\":2}"),
        { type: "complete", stopReason: "tool_calls" }
      ],
      [
        block(0, "done", true),
        { type: "provider-context", payload: { response: "two" } },
        { type: "usage", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } },
        { type: "complete", stopReason: "stop" }
      ]
    ];
    const emitted: unknown[] = [];
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: (_protocol, request) => {
        requests.push(request);
        return events(scripts.shift()!);
      }
    });
    runner.start(generation.generationId);
    runner.subscribe(generation.generationId, (event) => emitted.push(event));

    const result = await terminal(store, generation.generationId);
    expect(result.blocks).toEqual([
      expect.objectContaining({ index: 1, content: "final", complete: true }),
      expect.objectContaining({ index: 1000, content: "done", complete: true })
    ]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(execute).toHaveBeenCalledWith({ value: 2 }, expect.any(AbortSignal), expect.objectContaining({
      generationId: generation.generationId, toolCallId: "call-auto"
    }));
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ id: "call-auto" })] }),
      expect.objectContaining({ role: "tool", toolResults: [expect.objectContaining({ content: "tool output" })] })
    ]));
    expect(setProviderContext).toHaveBeenLastCalledWith(generation.generationId, { response: "two" });
    expect(setStepContext.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, { response: "one" }], [1, { response: "two" }]
    ]);
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
      expect.objectContaining({ type: "status", status: "completed", stopReason: "stop" })
    ]));
  });

  it("imports native provider images and attaches them to the assistant message", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const attach = vi.spyOn(store, "attachImagesToMessage");
    const importGeneratedBytes = vi.fn().mockResolvedValue({ id: "asset-generated" });
    const imageService = { importGeneratedBytes } as unknown as ImageService;
    const runner = makeRunner(store, {
      imageService,
      stream: () => events([
        { type: "image", dataBase64: "aW1hZ2U=" },
        { type: "complete", stopReason: "stop" }
      ])
    });

    runner.start(generation.generationId);
    await terminal(store, generation.generationId);

    expect(importGeneratedBytes).toHaveBeenCalledWith("mock-model-response-1", expect.any(Uint8Array));
    expect(attach).toHaveBeenCalledWith(store.getGenerationRecord(generation.generationId)!.assistantMessageId, ["asset-generated"]);
  });

  it("aggregates every usage dimension across tool rounds and derives missing totals", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const tool = serverTool("automatic", async () => "done");
    const scripts: ProviderEvent[][] = [
      [
        { type: "usage", usage: {
          inputTokens: 2,
          outputTokens: 1,
          reasoningTokens: 0,
          cachedInputTokens: 0
        } },
        toolCall("usage-call", "automatic", "{}"),
        { type: "complete", stopReason: "tool_calls" }
      ],
      [
        { type: "usage", usage: {
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 2,
          totalTokens: 20
        } },
        { type: "complete", stopReason: "stop" }
      ]
    ];
    const emitted: unknown[] = [];
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: () => events(scripts.shift()!)
    });
    runner.start(generation.generationId);
    runner.subscribe(generation.generationId, (event) => emitted.push(event));

    const result = await terminal(store, generation.generationId);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      reasoningTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 23
    });
    expect(emitted).toContainEqual({
      type: "usage",
      generationId: generation.generationId,
      usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 3 }
    });
  });

  it("persists explicitly reported zero usage", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const runner = makeRunner(store, {
      stream: () => events([
        { type: "usage", usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0
        } },
        { type: "complete", stopReason: "stop" }
      ])
    });

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0
    });
  });
});

describe("GenerationRunner tools and approval", () => {
  it("loads authorized lazy tools through search_tools on the next model step", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    setLazyTools(store, generation.generationId, ["weather_lookup"]);
    const requests: GenerateRequest[] = [];
    const execute = vi.fn(async () => "sunny");
    const scripts: ProviderEvent[][] = [
      [toolCall("search-call", "search_tools", '{"query":"weather"}')],
      [toolCall("weather-call", "weather_lookup", '{}')],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [serverTool("direct_tool", async () => "direct"), serverTool("weather_lookup", execute)],
      stream: (_protocol, request) => { requests.push(request); return events(scripts.shift()!); }
    });

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(requests.map((request) => (request.tools ?? []).map((tool) => tool.name))).toEqual([
      ["direct_tool", "search_tools"],
      ["direct_tool", "weather_lookup", "search_tools"],
      ["direct_tool", "weather_lookup", "search_tools"]
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(result.toolCalls[0]!.output!)).toMatchObject({
      loadedToolNames: ["weather_lookup"],
      tools: [expect.objectContaining({ name: "weather_lookup" })]
    });
  });

  it("rejects a lazy tool call that was not exposed", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    setLazyTools(store, generation.generationId, ["lazy_write"]);
    const execute = vi.fn(async () => "must not execute");
    const scripts: ProviderEvent[][] = [
      [toolCall("hallucinated", "lazy_write", '{}')],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [serverTool("lazy_write", execute, true)],
      stream: () => events(scripts.shift()!)
    });

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls[0]).toMatchObject({
      id: "hallucinated", approvalState: "failed", requiresApproval: false,
      error: "Tool lazy_write is not available"
    });
  });

  it("does not expose search matches when persisting the search result fails", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    setLazyTools(store, generation.generationId, ["lazy_read"]);
    const requests: GenerateRequest[] = [];
    const scripts: ProviderEvent[][] = [
      [toolCall("failed-search", "search_tools", '{"query":"lazy read"}')],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [serverTool("lazy_read", async () => "read")],
      persistToolOutput: async () => { throw new Error("persistence failed"); },
      stream: (_protocol, request) => { requests.push(request); return events(scripts.shift()!); }
    });

    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(requests).toHaveLength(2);
    expect((requests[1]!.tools ?? []).map((tool) => tool.name)).toEqual(["search_tools"]);
    expect(result.toolCalls[0]).toMatchObject({ approvalState: "failed", error: "persistence failed" });
  });

  it("reconstructs searched lazy tools when resuming after approval", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    setLazyTools(store, generation.generationId, ["lazy_approval"]);
    const execute = vi.fn(async () => "approved output");
    const requests: GenerateRequest[] = [];
    const scripts: ProviderEvent[][] = [
      [toolCall("resume-search", "search_tools", '{"query":"lazy approval"}')],
      [toolCall("resume-lazy", "lazy_approval", '{}')],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [serverTool("lazy_approval", execute, true)],
      stream: (_protocol, request) => { requests.push(request); return events(scripts.shift()!); }
    });

    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");
    store.updateToolCall("resume-lazy", { approvalState: "approved" });
    runner.start(generation.generationId);
    await terminal(store, generation.generationId);
    expect(execute).toHaveBeenCalledOnce();
    expect((requests[2]!.tools ?? []).map((tool) => tool.name)).toEqual(["lazy_approval", "search_tools"]);
  });

  it("exposes only authorized required tools after use_skill activation", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const record = store.getGenerationRecord(generation.generationId)!;
    record.agentSnapshot.execution.tools.overrides.disabled_required = false;
    record.agentSnapshot.execution.tools.directOverrides = { enabled_required: false };
    store.updateGenerationExtensionSnapshot(generation.generationId, record.agentSnapshot);
    const useSkill = serverTool("use_skill", async () => "skill instructions");
    useSkill.activatesTools = async () => ["enabled_required", "disabled_required", "absent_required"];
    const unavailable = serverTool("unavailable_required", async () => "unavailable");
    unavailable.available = false;
    const requests: GenerateRequest[] = [];
    const scripts: ProviderEvent[][] = [
      [toolCall("skill-call", "use_skill", '{"id":"agents.helper"}')],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [
        useSkill,
        serverTool("enabled_required", async () => "enabled"),
        serverTool("disabled_required", async () => "disabled"),
        unavailable
      ],
      stream: (_protocol, request) => { requests.push(request); return events(scripts.shift()!); }
    });

    runner.start(generation.generationId);
    await terminal(store, generation.generationId);
    expect((requests[0]!.tools ?? []).map((tool) => tool.name)).toEqual(["use_skill", "search_tools"]);
    expect((requests[1]!.tools ?? []).map((tool) => tool.name)).toEqual(["use_skill", "enabled_required", "search_tools"]);
    const sentNames = requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.name));
    expect(sentNames).not.toContain("disabled_required");
    expect(sentNames).not.toContain("absent_required");
    expect(sentNames).not.toContain("unavailable_required");
  });

  it("waits for approval, resumes an approved tool, and continues generation", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const execute = vi.fn(async () => "approved output");
    const tool = serverTool("needs_approval", execute, true);
    const scripts: ProviderEvent[][] = [
      [toolCall("approval-call", tool.definition.name, "{}"), { type: "complete", stopReason: "tool_calls" }],
      [block(0, "after approval", true), { type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: () => events(scripts.shift()!)
    });

    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");
    expect(store.getToolCall("approval-call")).toMatchObject({ approvalState: "pending", requiresApproval: true });
    expect(execute).not.toHaveBeenCalled();

    store.updateToolCall("approval-call", { approvalState: "approved" });
    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolCalls[0]).toMatchObject({ approvalState: "completed", output: "approved output" });
    expect(result.blocks[0]).toMatchObject({ index: 1000, content: "after approval" });
  });

  it("records denial without executing the tool and resumes", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const execute = vi.fn(async () => "should not run");
    const tool = serverTool("denied_tool", execute, true);
    const scripts: ProviderEvent[][] = [
      [toolCall("denied-call", tool.definition.name, "{}")],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, { buildTools: async () => [tool], stream: () => events(scripts.shift()!) });
    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");

    store.updateToolCall("denied-call", { approvalState: "denied" });
    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls[0]).toMatchObject({
      approvalState: "denied",
      output: JSON.stringify({ error: "Tool execution denied by user" })
    });
  });

  it("executes every unresolved automatic and approved call once after the final approval", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const failed = vi.fn(async () => { throw new Error("read failed"); });
    const approved = vi.fn(async () => "approved output");
    const later = vi.fn(async () => "later output");
    const requests: GenerateRequest[] = [];
    const scripts: ProviderEvent[][] = [
      [
        toolCall("auto-failed", "auto_failed", "{}"),
        toolCall("approval-call", "needs_approval", "{}"),
        toolCall("auto-later", "auto_later", "{}"),
        { type: "complete", stopReason: "tool_calls" }
      ],
      [{ type: "complete", stopReason: "stop" }]
    ];
    const runner = makeRunner(store, {
      buildTools: async () => [
        serverTool("auto_failed", failed),
        serverTool("needs_approval", approved, true),
        serverTool("auto_later", later)
      ],
      stream: (_protocol, request) => {
        requests.push(request);
        return events(scripts.shift()!);
      }
    });

    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");
    expect(failed).not.toHaveBeenCalled();
    expect(approved).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();

    store.updateToolCall("approval-call", { approvalState: "approved" });
    runner.start(generation.generationId);
    const result = await terminal(store, generation.generationId);

    expect(failed).toHaveBeenCalledOnce();
    expect(approved).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ id: "auto-failed", approvalState: "failed", error: "read failed" }),
      expect.objectContaining({ id: "approval-call", approvalState: "completed", output: "approved output" }),
      expect.objectContaining({ id: "auto-later", approvalState: "completed", output: "later output" })
    ]);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        toolResults: [
          expect.objectContaining({ callId: "auto-failed", isError: true }),
          expect.objectContaining({ callId: "approval-call", content: "approved output" }),
          expect.objectContaining({ callId: "auto-later", content: "later output" })
        ]
      })
    ]));
  });

  it.each([
    ["unavailable", undefined, "Tool unavailable is not available"],
    ["failed", serverTool("failed", async () => { throw new Error("tool broke"); }), "tool broke"]
  ] as const)("isolates an %s tool call failure and lets the model continue", async (_case, tool, message) => {
    const store = createStore();
    const generation = seedGeneration(store);
    const name = tool?.definition.name ?? "unavailable";
    const scripts: ProviderEvent[][] = [[toolCall(`call-${name}`, name, "{}")], [{ type: "complete", stopReason: "stop" }]];
    const runner = makeRunner(store, {
      buildTools: async () => tool ? [tool] : [],
      stream: () => events(scripts.shift()!)
    });
    runner.start(generation.generationId);

    const result = await terminal(store, generation.generationId);
    expect(result.status).toBe("completed");
    expect(result.toolCalls[0]).toMatchObject({ approvalState: "failed", error: message, output: JSON.stringify({ error: message }) });
  });

  it("normalizes malformed tool arguments as a generation failure", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const runner = makeRunner(store, { stream: () => events([toolCall("bad-args", "unknown", "[1]")]) });
    runner.start(generation.generationId);

    const result = await terminal(store, generation.generationId);
    expect(result).toMatchObject({ status: "failed", error: { code: "generation_failed" } });
    expect(result.error?.message).toContain("Invalid tool arguments: Tool arguments must be an object");
    expect(result.toolCalls).toEqual([]);
  });

  it("stores large tool output out of line", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const tool = serverTool("large", async () => "x".repeat(40_000));
    const scripts: ProviderEvent[][] = [[toolCall("call-large", "large", "{}")], [{ type: "complete", stopReason: "stop" }]];
    const runner = makeRunner(store, { buildTools: async () => [tool], stream: () => events(scripts.shift()!) });
    runner.start(generation.generationId);

    const result = await terminal(store, generation.generationId);
    expect(result.toolCalls[0]?.output).toContain("[Output truncated: 40000 characters.");
    expect(existsSync(resolve(store.dataDir, "tool_outputs/call-large.txt"))).toBe(true);
  });

  it("uses the Agent's configurable maximum tool rounds", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    let step = 0;
    const tool = serverTool("loop", async () => "again");
    const stream = vi.fn(() => events([toolCall(`loop-${step++}`, "loop", "{}")]));
    const runner = makeRunner(store, { buildTools: async () => [tool], stream });
    runner.start(generation.generationId);

    const result = await terminal(store, generation.generationId);
    expect(stream).toHaveBeenCalledTimes(32);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "generation_failed", message: "Tool execution exceeded the Agent limit of 32 model steps" }
    });
    expect(result.toolCalls).toHaveLength(32);
  });
});

describe("GenerationRunner errors and cancellation", () => {
  it.each([false, true])("preserves shell failure details even when output persistence fails: %s", async (diskFailure) => {
    const store = createStore();
    const generation = seedGeneration(store);
    const shell = serverTool("shell", async () => { throw new ShellError({
      exitCode: 9, signal: null, stdout: "x".repeat(40000), stderr: "root cause", timedOut: false, cancelled: false, truncated: false
    }, "command failed"); });
    let step = 0;
    const runner = makeRunner(store, {
      buildTools: async () => [shell],
      ...(diskFailure ? { persistToolOutput: async () => { throw new Error("disk full"); } } : {}),
      stream: () => events(step++ === 0 ? [toolCall("shell-error", "shell", "{}")] : [{ type: "complete", stopReason: "stop" }])
    });
    runner.start(generation.generationId);
    await terminal(store, generation.generationId);
    expect(store.getToolCall("shell-error")).toMatchObject({ approvalState: "failed", error: "command failed" });
    expect(JSON.parse(store.getToolCall("shell-error")!.output!)).toMatchObject({
      error: "command failed", exitCode: 9, stderr: "root cause", timedOut: false, cancelled: false, truncated: true
    });
    await runner.close();
  });
  it.each([
    [new ProviderError("provider_down", "provider failed"), "provider_down", "provider failed"],
    [new ContextError("context_bad", "context failed"), "context_bad", "context failed"],
    [new Error("plain failure"), "generation_failed", "plain failure"],
    ["not an error", "generation_failed", "生成失败"]
  ])("normalizes %p", async (error, code, message) => {
    const store = createStore();
    const generation = seedGeneration(store);
    const runner = error instanceof ContextError
      ? makeRunner(store, { buildContext: async () => { throw error; } })
      : makeRunner(store, { stream: () => throwingEvents(error) });
    runner.start(generation.generationId);

    expect(await terminal(store, generation.generationId)).toMatchObject({ status: "failed", error: { code, message } });
  });

  it("cancels an active stream and emits a stopped terminal state", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const observed: unknown[] = [];
    const runner = makeRunner(store, { stream: (_protocol, request) => abortableStream(request.signal) });
    runner.start(generation.generationId);
    runner.subscribe(generation.generationId, (event) => observed.push(event));
    await until(() => store.getGeneration(generation.generationId)?.status === "running");

    expect(runner.cancel(generation.generationId)).toBe(true);
    const result = await terminal(store, generation.generationId);
    expect(result).toMatchObject({ status: "stopped", stopReason: "cancelled", error: null });
    expect(observed).toContainEqual(expect.objectContaining({ type: "status", status: "stopped", stopReason: "cancelled" }));
  });

  it("cancels a generation waiting for approval and denies every pending call", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const tool = serverTool("write", async () => "unused", true);
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: () => events([toolCall("pending-a", "write", "{}"), toolCall("pending-b", "write", "{}")])
    });
    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");

    expect(runner.cancel(generation.generationId)).toBe(true);
    expect(store.getGeneration(generation.generationId)).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    expect(store.listToolCalls(generation.generationId)).toEqual([
      expect.objectContaining({ approvalState: "denied", output: expect.stringContaining("Generation cancelled") }),
      expect.objectContaining({ approvalState: "denied", output: expect.stringContaining("Generation cancelled") })
    ]);
  });

  it("cancels a mixed approval batch with a denial and failure result for every call", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const runner = makeRunner(store, {
      buildTools: async () => [serverTool("read", async () => "unused"), serverTool("write", async () => "unused", true)],
      stream: () => events([toolCall("unstarted-read", "read", "{}"), toolCall("pending-write", "write", "{}")])
    });
    runner.start(generation.generationId);
    await inactiveWithStatus(runner, store, generation, "waiting-approval");

    expect(runner.cancel(generation.generationId)).toBe(true);
    const calls = store.listToolCalls(generation.generationId);
    expect(calls).toEqual([
      expect.objectContaining({
        id: "unstarted-read", approvalState: "failed",
        output: expect.stringContaining("Generation cancelled"), error: expect.stringContaining("Generation cancelled")
      }),
      expect.objectContaining({
        id: "pending-write", approvalState: "denied",
        output: expect.stringContaining("Generation cancelled"), error: null
      })
    ]);
    expect(calls.every((call) => call.output !== null || call.error !== null)).toBe(true);
    expect(store.currentGenerationMessages(generation.generationId).at(-1)).toMatchObject({
      role: "tool",
      toolResults: [
        expect.objectContaining({ callId: "unstarted-read", isError: true }),
        expect.objectContaining({ callId: "pending-write" })
      ]
    });
  });

  it("keeps cancellation terminal when a running tool resolves late", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const gate = deferred<string>();
    const tool = serverTool("slow", async () => gate.promise);
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: () => events([toolCall("slow-call", "slow", "{}")])
    });
    runner.start(generation.generationId);
    await until(() => store.getToolCall("slow-call")?.approvalState === "running");

    expect(runner.cancel(generation.generationId)).toBe(true);
    gate.resolve("late output");
    expect(await terminal(store, generation.generationId)).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    await turn();
    expect(store.getGeneration(generation.generationId)).toMatchObject({ status: "stopped", stopReason: "cancelled" });
  });

  it("stopAll aborts every live job", async () => {
    const store = createStore();
    const first = seedGeneration(store);
    const second = seedGeneration(store);
    const runner = makeRunner(store, { stream: (_protocol, request) => abortableStream(request.signal) });
    runner.start(first.generationId);
    runner.start(second.generationId);
    await until(() => runner.isConversationActive(first.conversationId) && runner.isConversationActive(second.conversationId));

    runner.stopAll();
    expect((await terminal(store, first.generationId)).status).toBe("stopped");
    expect((await terminal(store, second.generationId)).status).toBe("stopped");
  });

  it.each(["context", "tools", "stream", "tool"] as const)("fences a late %s result after the cancellation deadline", async (stage) => {
    const store = createStore();
    const generation = seedGeneration(store);
    const gate = deferred<void>();
    const entered = vi.fn();
    const pause = async () => { entered(); await gate.promise; };
    const onSettled = vi.fn();
    const slowTool = serverTool("slow", async () => { await pause(); return "late tool output"; });
    const runner = makeRunner(store, {
      onSettled,
      ...(stage === "context" ? { buildContext: async () => { await pause(); return {
        systemPrompt: "", messages: [], metadata: { policy: "full" as const, omittedMessages: 0, estimatedInputTokens: 0, summaryUsed: false }
      }; } } : {}),
      buildTools: async () => { if (stage === "tools") await pause(); return [slowTool]; },
      stream: () => (async function* () {
        if (stage === "tool") { yield toolCall("late-call", "slow", "{}"); yield { type: "complete", stopReason: "tool_calls" }; return; }
        if (stage === "stream") await pause();
        yield block(0, "late provider output", true);
        yield { type: "complete", stopReason: "stop" } satisfies ProviderEvent;
      })()
    });
    runner.start(generation.generationId);
    await until(() => entered.mock.calls.length === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(runner.cancel(generation.generationId)).toBe(true);
    expect(runner.cancel(generation.generationId)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getGeneration(generation.generationId)?.status).toBe("stopped");
    expect(runner.isConversationActive(generation.conversationId)).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    const stopped = store.getGeneration(generation.generationId);
    gate.resolve();
    await turn(); await turn();
    expect(store.getGeneration(generation.generationId)).toEqual(stopped);
    expect(onSettled).toHaveBeenCalledTimes(1);
    await runner.close();
  });

  it("closes idempotently, aborts a blocked provider, and rejects new starts", async () => {
    const store = createStore();
    const active = seedGeneration(store);
    const notStarted = seedGeneration(store);
    const runner = makeRunner(store, { stream: (_protocol, request) => abortableStream(request.signal) });
    runner.start(active.generationId);
    await until(() => store.getGeneration(active.generationId)?.status === "running");

    const firstClose = runner.close();
    const secondClose = runner.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;

    expect(store.getGeneration(active.generationId)).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    expect(runner.isConversationActive(active.conversationId)).toBe(false);
    expect(() => runner.start(notStarted.generationId)).toThrow("Generation runner is closing");
    await runner.close();
  });

  it("aborts and awaits a tool blocked on its cancellation signal", async () => {
    const store = createStore();
    const generation = seedGeneration(store);
    const tool = serverTool("blocked", async (_input, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "unreachable";
    });
    const runner = makeRunner(store, {
      buildTools: async () => [tool],
      stream: () => events([toolCall("blocked-call", "blocked", "{}")])
    });
    runner.start(generation.generationId);
    await until(() => store.getToolCall("blocked-call")?.approvalState === "running");

    await runner.close();

    expect(store.getGeneration(generation.generationId)).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    expect(runner.isConversationActive(generation.conversationId)).toBe(false);
  });
});

function seedGeneration(store: Store) {
  const { connection, model } = seedModel(store);
  const started = store.startConversation({ text: "question", modelId: model.id, contextPolicy: "full" });
  return {
    generationId: started.generation.generationId,
    conversationId: started.conversation.id,
    modelId: model.id,
    connectionId: connection.id
  };
}

function makeRunner(store: Store, dependencies: Partial<GenerationRunnerDependencies> = {}): GenerationRunner {
  return new GenerationRunner(store, {
    buildContext: async (_store, record, _model, _connection, _signal, _images, options) => ({
      systemPrompt: options?.additionalSystemPrompt ?? "",
      messages: store.currentGenerationMessages(record.id),
      metadata: { policy: "full", omittedMessages: 0, estimatedInputTokens: 1, summaryUsed: false }
    }),
    buildTools: async () => [],
    memoryPrompt: () => "",
    stream: () => events([{ type: "complete", stopReason: "stop" }]),
    ...dependencies
  });
}

function serverTool(
  name: string,
  execute: ServerTool["execute"],
  requiresApproval: boolean | ServerTool["requiresApproval"] = false
): ServerTool {
  return {
    definition: { name, description: `${name} description`, inputSchema: { type: "object" } },
    label: name,
    category: "local",
    available: true,
    requiresApproval: typeof requiresApproval === "function" ? requiresApproval : () => requiresApproval,
    execute
  };
}

function setLazyTools(store: Store, generationId: string, names: string[]): void {
  const record = store.getGenerationRecord(generationId)!;
  record.agentSnapshot.execution.tools.directOverrides = Object.fromEntries(names.map((name) => [name, false]));
  store.updateGenerationExtensionSnapshot(generationId, record.agentSnapshot);
}

function block(index: number, content: string, complete: boolean, blockType: "text" | "reasoning" = "text"): ProviderEvent {
  return { type: "block", index, blockType, content, complete };
}

function toolCall(id: string, name: string, args: string): ProviderEvent {
  return { type: "tool-call", call: { id, name, arguments: args } };
}

// Successful fixture streams always carry output and an explicit terminal event.
async function* events(items: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  if (!items.some((item) => item.type === "tool-call" || item.type === "image" || (item.type === "block" && item.blockType !== "reasoning" && item.content))) {
    yield block(1, "done", true);
  }
  for (const item of items) yield item;
  if (!items.some((item) => item.type === "complete")) yield { type: "complete", stopReason: "stop" };
}

async function* throwingEvents(error: unknown): AsyncGenerator<ProviderEvent> {
  throw error;
}

async function* blockingStream(request: GenerateRequest, gate: Promise<void>): AsyncGenerator<ProviderEvent> {
  yield block(0, "working", false);
  await Promise.race([
    gate,
    new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
  ]);
  yield { type: "complete", stopReason: "stop" };
}

async function* abortableStream(signal: AbortSignal): AsyncGenerator<ProviderEvent> {
  yield block(0, "working", false);
  await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function terminal(store: Store, generationId: string) {
  await until(() => ["completed", "stopped", "failed"].includes(store.getGeneration(generationId)?.status ?? ""));
  await turn();
  return store.getGeneration(generationId)!;
}

async function inactiveWithStatus(
  runner: GenerationRunner,
  store: Store,
  generation: { generationId: string; conversationId: string },
  status: string
) {
  await until(() => store.getGeneration(generation.generationId)?.status === status && !runner.isConversationActive(generation.conversationId));
  return store.getGeneration(generation.generationId)!;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("condition did not become true");
}

function turn(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

it.each([false, true])("snapshots Markdown separately from model output; formatter failure=%s", async (broken) => {
  const store = createStore(); const generation = seedGeneration(store);
  const execute = vi.fn(async () => "raw output");
  let step = 0;
  const requests: GenerateRequest[] = [];
  const runner = makeRunner(store, {
    buildTools: async () => [{ ...serverTool("formatted", execute),
      formatArguments: () => ({ summary: "ARG MARKDOWN", detail: "**input**" }),
      formatResult: () => { if (broken) throw Error("formatter broken"); return { summary: "RESULT MARKDOWN", detail: "**output**" }; }
    }],
    stream: (_protocol, request) => {
      requests.push(request);
      return events(step++ === 0 ? [toolCall("formatted-call", "formatted", "{}"), { type: "complete", stopReason: "tool_calls" }] : [{ type: "complete", stopReason: "stop" }]);
    }
  });
  runner.start(generation.generationId);
  const result = await terminal(store, generation.generationId);
  expect(result.status).toBe("completed");
  expect(result.toolCalls[0]).toMatchObject({ output: "raw output", approvalState: "completed", presentation: { arguments: { summary: "ARG MARKDOWN" } } });
  expect(result.toolCalls[0]?.presentation?.result?.summary).toBe(broken ? undefined : "RESULT MARKDOWN");
  expect(JSON.stringify(requests)).not.toContain("MARKDOWN");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("saves argument Markdown before approval without executing the tool", async () => {
  const store = createStore(); const generation = seedGeneration(store);
  const execute = vi.fn(async () => "raw");
  const runner = makeRunner(store, {
    buildTools: async () => [{ ...serverTool("approve-format", execute, true), formatArguments: () => ({ summary: "Approval summary" }) }],
    stream: () => events([toolCall("approval-format-call", "approve-format", "{}")])
  });
  runner.start(generation.generationId);
  const pending = await inactiveWithStatus(runner, store, generation, "waiting-approval");
  expect(pending.toolCalls[0]).toMatchObject({ approvalState: "pending", presentation: { arguments: { summary: "Approval summary" } } });
  expect(execute).not.toHaveBeenCalled();
});

it("persists execution before formatting and ignores late presentation after cancellation", async () => {
  const store = createStore(); const generation = seedGeneration(store);
  const gate = deferred<import("@llm-chat/contracts").ToolMarkdown>();
  const runner = makeRunner(store, {
    buildTools: async () => [{ ...serverTool("format-delay", async () => "saved result"), formatResult: () => gate.promise }],
    stream: () => events([toolCall("format-delay-call", "format-delay", "{}")])
  });
  runner.start(generation.generationId);
  await until(() => store.getToolCall("format-delay-call")?.approvalState === "completed");
  const completedAt = store.getToolCall("format-delay-call")!.completedAt;
  runner.cancel(generation.generationId);
  gate.resolve({ detail: "late formatting" });
  await terminal(store, generation.generationId);
  expect(store.getToolCall("format-delay-call")).toMatchObject({ output: "saved result", approvalState: "completed", completedAt });
  expect(store.getToolCall("format-delay-call")?.presentation?.result).toBeUndefined();
});
