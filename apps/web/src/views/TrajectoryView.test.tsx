import { describe, expect, it } from "vitest";
import type { BackgroundTaskDto } from "@llm-chat/contracts";
import { makeGeneration, makeMessage } from "../../test/fixtures";
import { projectTurns } from "./TrajectoryView";

describe("projectTurns", () => {
  it("projects persisted messages, generations, tool calls and tasks without inventing events", () => {
    const generation = makeGeneration({
      id: "gen-trajectory",
      blocks: [{ id: "block-1", index: 0, stepIndex: 0, type: "text", content: "最终答案", complete: true }],
      toolCalls: [{
        id: "tool-1",
        index: 0,
        stepIndex: 0,
        name: "shell",
        arguments: '{"command":"pnpm test"}',
        approvalState: "approved",
        requiresApproval: true,
        output: "passed",
        error: null,
        startedAt: 10,
        completedAt: 20,
        artifacts: []
      }]
    });
    const task: BackgroundTaskDto = {
      id: "task-1",
      conversationId: "conv-1",
      generationId: generation.id,
      agentId: "agent-1",
      agentName: "测试助手",
      agentRevision: 1,
      command: "pnpm test",
      mode: "pipe",
      workspacePath: "/workspace",
      status: "completed",
      expectedDurationMs: null,
      hardTimeoutMs: null,
      overdue: false,
      exitCode: 0,
      error: null,
      outputCursor: 6,
      earliestCursor: 0,
      createdAt: 3,
      startedAt: 4,
      completedAt: 5
    };
    const messages = [
      makeMessage({ id: "user-1", role: "user", text: "运行测试", createdAt: 1 }),
      makeMessage({ id: "assistant-1", role: "assistant", activeGenerationId: generation.id, generations: [generation], createdAt: 2 })
    ];

    const turns = projectTurns(messages, [task]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "user-1",
      userText: "运行测试",
      assistantMessageId: "assistant-1",
      generations: [generation],
      tasks: [task]
    });
    expect(turns[0]?.searchText).toContain("最终答案");
    expect(turns[0]?.searchText).toContain("shell");
    expect(turns[0]?.searchText).toContain("pnpm test");
  });

  it("ignores assistant messages that have no preceding user turn", () => {
    expect(projectTurns([makeMessage({ role: "assistant", generations: [makeGeneration()] })], [])).toEqual([]);
  });
});
