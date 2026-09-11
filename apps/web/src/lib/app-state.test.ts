import { describe, expect, it, vi } from "vitest";
import { makeBackgroundTask, makeGeneration, makeMessage } from "../../test/fixtures";
import { FakeEventSource } from "../../test/setup";
import { appStore, loadMessages, refreshTaskCounts, restartGenerationTracking, startAppEvents, trackGeneration } from "./app-state";

describe("message compatibility", () => {
  it("normalizes attachment and generation arrays omitted by an older server", async () => {
    history.replaceState(null, "", "/c/conv-legacy");
    const { attachments: _attachments, generations: _generations, ...legacyMessage } = makeMessage({
      id: "legacy-user",
      role: "user",
      text: "旧服务消息"
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([legacyMessage]), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));

    const messages = await loadMessages("conv-legacy");

    expect(messages[0]).toMatchObject({ attachments: [], generations: [] });
    expect(appStore.get().messages["conv-legacy"]?.[0]).toMatchObject({ attachments: [], generations: [] });
  });
});

describe("event stream lifecycle", () => {
  it("uses connecting before the first open and reconnecting only after a disconnect", () => {
    appStore.set({ eventsConnectionState: "connecting" });
    startAppEvents();
    const source = FakeEventSource.instances.at(-1)!;

    source.onerror?.();
    expect(appStore.get().eventsConnectionState).toBe("connecting");
    source.onopen?.();
    expect(appStore.get().eventsConnectionState).toBe("connected");
    source.onerror?.();
    expect(appStore.get().eventsConnectionState).toBe("reconnecting");
  });

  it("opens a fresh generation stream after approval and receives the tool result", () => {
    history.replaceState(null, "", "/c/approval");
    const generationId = "gen-approval";
    const messageId = "message-approval";
    const pending = {
      id: "call-approval",
      index: 0,
      stepIndex: 0,
      name: "workspace_shell",
      arguments: "{}",
      approvalState: "pending" as const,
      requiresApproval: true,
      output: null,
      error: null,
      startedAt: null,
      completedAt: null,
      artifacts: []
    };
    const generation = makeGeneration({ id: generationId, status: "running", toolCalls: [pending] });
    appStore.set({
      messages: {
        approval: [makeMessage({ id: messageId, activeGenerationId: generationId, generations: [generation] })]
      }
    });

    trackGeneration("approval", messageId, generationId);
    const waitingStream = FakeEventSource.instances.at(-1)!;
    waitingStream.emit("status", { type: "status", generationId, status: "waiting-approval", stopReason: "tool_approval" });
    expect(waitingStream.closed).toBe(true);

    restartGenerationTracking("approval", messageId, generationId);
    const resumedStream = FakeEventSource.instances.at(-1)!;
    expect(resumedStream).not.toBe(waitingStream);
    resumedStream.emit("tool-call", {
      type: "tool-call",
      generationId,
      toolCall: { ...pending, approvalState: "completed", output: "done", startedAt: 10, completedAt: 11 }
    });

    expect(appStore.get().messages.approval?.[0]?.generations[0]?.toolCalls[0]).toMatchObject({
      approvalState: "completed",
      output: "done"
    });
    resumedStream.emit("status", { type: "status", generationId, status: "waiting-approval", stopReason: "tool_approval" });
  });
});

describe("background task counts", () => {
  it("groups active tasks by their owning conversation", async () => {
    const tasks = [
      makeBackgroundTask({ id: "running-1", conversationId: "conv-1", status: "running" }),
      makeBackgroundTask({ id: "queued-1", conversationId: "conv-1", status: "queued" }),
      makeBackgroundTask({ id: "running-2", conversationId: "conv-2", status: "starting" }),
      makeBackgroundTask({ id: "done", conversationId: "conv-2", status: "completed" })
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tasks), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    appStore.set({ runningTasksByConversation: { stale: 4 } });

    await refreshTaskCounts();

    expect(appStore.get().runningTasksByConversation).toEqual({ "conv-1": 2, "conv-2": 1 });
  });
});

it("merges streamed blocks into persisted snapshots by position rather than their different IDs", () => {
  const id = "snapshot-identity";
  const generation = makeGeneration({
    id, status: "running",
    blocks: [{ id: "database-block-id", stepIndex: 0, index: 0, type: "reasoning", content: "before", complete: false }]
  });
  const message = makeMessage({ id: "snapshot-message", activeGenerationId: id, generations: [generation] });
  appStore.set({ messages: { "snapshot-conversation": [message] } });
  trackGeneration("snapshot-conversation", message.id, id);
  const stream = FakeEventSource.instances.at(-1)!;
  stream.emit("block-delta", {
    type: "block-delta", generationId: id,
    block: { id: id + ":0", stepIndex: 0, index: 0, type: "reasoning", content: "after", complete: false }
  });
  const blocks = appStore.get().messages["snapshot-conversation"]![0]!.generations[0]!.blocks;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.content).toBe("after");
  stream.close();
});
