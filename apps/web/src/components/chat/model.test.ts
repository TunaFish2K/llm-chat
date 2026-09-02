import { describe, expect, it } from "vitest";
import type { ToolCallDto } from "@llm-chat/contracts";
import { makeGeneration, makeMessage } from "../../../test/fixtures";
import {
  activeGeneration,
  answerText,
  buildTimeline,
  prettyJson,
  shortPath,
  withGenerationValue
} from "./model";

function toolCall(id: string, stepIndex: number, index: number): ToolCallDto {
  return {
    id,
    index,
    stepIndex,
    name: "workspace_shell",
    arguments: "{}",
    approvalState: "completed",
    requiresApproval: false,
    output: "ok",
    error: null,
    startedAt: 1,
    completedAt: 2,
    artifacts: []
  };
}

describe("chat model helpers", () => {
  it("interleaves blocks and tools by step with blocks first on a tie", () => {
    const generation = makeGeneration({
      blocks: [
        { id: "b2", stepIndex: 1, index: 1, type: "text", content: "done", complete: true },
        { id: "b1", stepIndex: 0, index: 0, type: "reasoning", content: "think", complete: true }
      ],
      toolCalls: [toolCall("t2", 1, 0), toolCall("t1", 0, 0)]
    });

    expect(buildTimeline(generation).map((entry) => `${entry.kind}:${entry.kind === "block" ? entry.block.id : entry.call.id}`))
      .toEqual(["block:b1", "tool:t1", "block:b2", "tool:t2"]);
  });

  it("uses the pinned generation and falls back to the newest generation", () => {
    const first = makeGeneration({ id: "first" });
    const latest = makeGeneration({ id: "latest" });

    expect(activeGeneration(makeMessage({ activeGenerationId: "first", generations: [first, latest] }))).toBe(first);
    expect(activeGeneration(makeMessage({ activeGenerationId: "missing", generations: [first, latest] }))).toBe(latest);
    expect(activeGeneration(makeMessage())).toBeNull();
  });

  it("collects only answer blocks and preserves their order", () => {
    const generation = makeGeneration({
      blocks: [
        { id: "r", stepIndex: 0, index: 0, type: "reasoning", content: "hidden", complete: true },
        { id: "a", stepIndex: 0, index: 1, type: "text", content: "hello", complete: true },
        { id: "b", stepIndex: 1, index: 0, type: "text", content: " world", complete: true }
      ]
    });

    expect(answerText(generation)).toBe("hello world");
  });

  it("adds and prunes nested generation overrides without mutating the input", () => {
    const initial = { contextPolicy: "trim" as const };
    const added = withGenerationValue(initial, "common", "temperature", 0.4);
    const removed = withGenerationValue(added, "common", "temperature", undefined);

    expect(initial).toEqual({ contextPolicy: "trim" });
    expect(added).toEqual({ contextPolicy: "trim", generation: { common: { temperature: 0.4 } } });
    expect(removed).toEqual(initial);
  });

  it("formats valid JSON while leaving plain text untouched", () => {
    expect(prettyJson('{"ok":true}')).toBe('{\n  "ok": true\n}');
    expect(prettyJson("plain text")).toBe("plain text");
    expect(shortPath("/home/tuna/Documents")).toBe("Documents");
    expect(shortPath("/")).toBe("/");
  });
});
