import { describe, expect, it } from "vitest";
import type { ToolCallDto } from "@llm-chat/contracts";
import { makeGeneration, makeMessage } from "../../../test/fixtures";
import { imageRetryMessages, makeImageJob } from "../../../test/image-tool-fixtures";
import {
  activeGeneration,
  userReplyTargets,
  answerText,
  buildTimeline,
  groupTimeline,
  projectImageJobs,
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

  it("groups consecutive processing steps but keeps text and refusals in order", () => {
    const grouped = groupTimeline(makeGeneration({
      blocks: [
        { id: "r1", stepIndex: 0, index: 0, type: "reasoning", content: "think", complete: true },
        { id: "a1", stepIndex: 1, index: 0, type: "text", content: "progress", complete: true },
        { id: "r2", stepIndex: 2, index: 0, type: "reasoning", content: "think again", complete: true },
        { id: "no", stepIndex: 3, index: 0, type: "refusal", content: "refused", complete: true }
      ], toolCalls: [toolCall("t1", 0, 0), toolCall("t2", 2, 0)]
    }));
    expect(grouped.map((item) => item.kind === "process" ? [item.id, item.entries.length, item.followedByAnswer] : item.kind === "block" ? item.block.id : item.call.id))
      .toEqual([["r1", 2, true], "a1", ["r2", 2, false], "no"]);
    expect(groupTimeline(makeGeneration())).toEqual([]);
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

describe("image task projection", () => {
  it("places each failed attempt and image before the next answer without rewriting stored messages", () => {
    const messages = imageRetryMessages();
    const original = structuredClone(messages);
    const projected = projectImageJobs(messages);
    expect(projected.messages.map((message) => message.id)).toEqual(["user", "reply"]);
    const timeline = groupTimeline(messages[1]!.generations[0]!, projected.imageJobs);
    expect(timeline.map((item) => item.kind === "block" ? item.block.content : item.kind === "process" ? "tool" : item.jobs[0]!.id))
      .toEqual(["开始画图", "tool", "job-1", "第一次重试", "tool", "job-2", "第二次重试", "tool", "job-3", "海滩已画好"]);
    expect(messages).toEqual(original);
  });

  it("owns jobs across inactive versions and leaves independent or unmatched history visible", () => {
    const messages = imageRetryMessages();
    const reply = messages[1]!;
    reply.generations.push(makeGeneration({ id: "gen-2", version: 2 }));
    reply.activeGenerationId = "gen-2";
    const independent = makeMessage({ id: "independent", imageGenerationJob: makeImageJob({ toolCallId: null }) });
    const orphan = makeMessage({ id: "orphan", imageGenerationJob: makeImageJob({ toolCallId: "missing" }) });
    const projected = projectImageJobs([...messages, independent, orphan]);
    expect(projected.messages.map((message) => message.id)).toEqual(["user", "reply", "independent", "orphan"]);
    expect(groupTimeline(activeGeneration(reply)!, projected.imageJobs)).toEqual([]);
    expect(groupTimeline(reply.generations[0]!, projected.imageJobs).filter((item) => item.kind === "image-result")).toHaveLength(3);
  });

  it("reserves image boundaries before job events without splitting model discovery", () => {
    const generation = imageRetryMessages()[1]!.generations[0]!;
    const discovery = { ...generation.toolCalls[0]!, id: "discovery", arguments: '{"action":"list_models"}' };
    generation.toolCalls.unshift(discovery);
    const timeline = groupTimeline(generation);
    expect(timeline.filter((item) => item.kind === "image-result").map((item) => item.call.id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(timeline[1]).toMatchObject({ kind: "process", entries: [{ call: discovery }, { call: generation.toolCalls[1] }] });
  });
});

describe("user reply targets", () => {
  it("selects the first generated answer in each turn without crossing users or choosing greetings", () => {
    const user = (id: string) => makeMessage({ id, role: "user", generations: [] });
    const reply = (id: string) => makeMessage({ id, generations: [makeGeneration()] });
    expect([...userReplyTargets([
      makeMessage({ id: "greeting", generations: [] }), user("first"), reply("first-answer"), reply("continued"),
      user("unanswered"), user("last"), makeMessage({ id: "image", generations: [] }), reply("last-answer"), user("pending")
    ])]).toEqual([["first", "first-answer"], ["last", "last-answer"]]);
  });
});
