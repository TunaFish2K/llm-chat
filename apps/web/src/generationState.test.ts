import type { GenerationBlockDto, GenerationDto, GenerationEvent, MessageDto, ToolCallDto } from "@llm-chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyGenerationEvent, blockText, streamEnded, updateGeneration, upsertBlock } from "./generationState";

const block = (id: string, index: number, content = id, type: GenerationBlockDto["type"] = "text"): GenerationBlockDto => ({
  id, index, type, content, complete: false
});

const tool = (id: string, index: number): ToolCallDto => ({
  id, index, name: id, arguments: "{}", approvalState: "pending", requiresApproval: true,
  output: null, error: null, startedAt: null, completedAt: null
});

const generation = (id = "g1"): GenerationDto => ({
  id, version: 1, status: "running", connectionName: "Local", protocol: "openai-responses", modelKey: "gpt-test",
  settings: { common: { maxOutputTokens: 100, stopSequences: [] }, protocol: {}, reasoningEffort: "medium" },
  blocks: [block("b2", 2), block("b0", 0)], toolCalls: [tool("t2", 2)], usage: { inputTokens: 1 },
  stopReason: "retained", error: null, context: null, createdAt: 1, completedAt: null
});

const messages = (): MessageDto[] => [{
  id: "m1", role: "assistant", text: null, generatedModel: null, activeGenerationId: "g1",
  generations: [generation(), generation("g2")], createdAt: 1
}, {
  id: "u1", role: "user", text: "hello", generatedModel: null, activeGenerationId: null,
  generations: [], createdAt: 0
}];

describe("generation state", () => {
  it.each([
    { type: "snapshot", generation: { ...generation(), status: "completed" } },
    { type: "block-delta", generationId: "g1", block: block("replacement", 0) },
    { type: "usage", generationId: "g1", usage: { totalTokens: 42 } },
    { type: "tool-call", generationId: "g1", toolCall: tool("t0", 0) },
    { type: "status", generationId: "g1", status: "completed", stopReason: "end_turn" },
    { type: "error", generationId: "g1", code: "boom", message: "failed" }
  ] satisfies GenerationEvent[])("reduces $type without mutating input", (event) => {
    const input = messages();
    const original = structuredClone(input);
    const result = applyGenerationEvent(input, event);
    expect(input).toEqual(original);
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
    expect(result[1]).not.toBe(input[1]);
  });

  it("applies each event payload and keeps upserts sorted", () => {
    let value = messages();
    value = applyGenerationEvent(value, { type: "block-delta", generationId: "g1", block: block("b1", 1, "middle") });
    value = applyGenerationEvent(value, { type: "block-delta", generationId: "g1", block: block("b0-new", 0, "first") });
    value = applyGenerationEvent(value, { type: "tool-call", generationId: "g1", toolCall: tool("t0", 0) });
    value = applyGenerationEvent(value, { type: "tool-call", generationId: "g1", toolCall: { ...tool("t2", 2), approvalState: "completed" } });
    value = applyGenerationEvent(value, { type: "usage", generationId: "g1", usage: { totalTokens: 11 } });
    const current = value[0]!.generations[0]!;
    expect(current.blocks.map(({ id }) => id)).toEqual(["b0-new", "b1", "b2"]);
    expect(current.toolCalls.map(({ id }) => id)).toEqual(["t0", "t2"]);
    expect(current.toolCalls[1]!.approvalState).toBe("completed");
    expect(current.usage).toEqual({ totalTokens: 11 });
  });

  it("replaces a snapshot and normalizes error events", () => {
    const snapshot = { ...generation(), status: "completed" as const, stopReason: "snapshot" };
    expect(applyGenerationEvent(messages(), { type: "snapshot", generation: snapshot })[0]!.generations[0]).toBe(snapshot);
    const failed = applyGenerationEvent(messages(), { type: "error", generationId: "g1", code: "provider", message: "bad" })[0]!.generations[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "provider", message: "bad" });
  });

  it("retains the previous stop reason when a status event omits it", () => {
    const retained = applyGenerationEvent(messages(), { type: "status", generationId: "g1", status: "stopped" })[0]!.generations[0]!;
    const replaced = applyGenerationEvent(messages(), { type: "status", generationId: "g1", status: "completed", stopReason: "done" })[0]!.generations[0]!;
    expect(retained.stopReason).toBe("retained");
    expect(replaced.stopReason).toBe("done");
  });

  it("does not call the reducer for an unknown generation", () => {
    const update = vi.fn();
    const input = messages();
    const result = updateGeneration(input, "missing", update);
    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual(input);
    expect(applyGenerationEvent(input, { type: "usage", generationId: "missing", usage: { totalTokens: 9 } })).toEqual(input);
  });

  it("upserts blocks by index and extracts block text", () => {
    const original = [block("two", 2, "answer"), block("old", 0, "old")];
    const result = upsertBlock(original, block("new", 0, "thought", "reasoning"));
    expect(result.map(({ id }) => id)).toEqual(["new", "two"]);
    expect(original.map(({ id }) => id)).toEqual(["two", "old"]);
    expect(blockText({ ...generation(), blocks: result }, ["reasoning"])).toBe("thought");
    expect(blockText({ ...generation(), blocks: [...result, block("r2", 3, "next", "reasoning")] }, ["reasoning"])).toBe("thought\nnext");
    expect(blockText({ ...generation(), blocks: result }, ["text", "refusal"])).toBe("answer");
  });

  it("recognizes terminal stream statuses", () => {
    for (const status of ["waiting-approval", "completed", "stopped", "failed", "interrupted"]) expect(streamEnded(status)).toBe(true);
    expect(streamEnded("queued")).toBe(false);
    expect(streamEnded("running")).toBe(false);
  });
});
