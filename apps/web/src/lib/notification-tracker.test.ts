import { describe, expect, it, vi } from "vitest";
import type { AppEvent, GenerationNotificationState } from "@llm-chat/contracts";
import { makeGeneration } from "../../test/fixtures";
import { NotificationTracker } from "./notification-tracker";
import { generationNotices } from "./notification-protocol";

const state = (patch: Partial<GenerationNotificationState> = {}): GenerationNotificationState => ({
  generationId: "g", messageId: "m", conversationId: "c", conversationTitle: "会话", status: "running", stopReason: null, pendingTools: [], ...patch
});
const snapshot = (active: GenerationNotificationState[], id = 10, sourceId = "server"): AppEvent => ({ type: "generation-snapshot", id, sourceId, active });
const update = (generation: GenerationNotificationState, id = 11): AppEvent => ({ type: "generation-state", id, generation });

describe("notification state reconciliation", () => {
  it("baselines existing approvals, ignores history and unrelated events, and handles new batches once", () => {
    const deliver = vi.fn(); const read = vi.fn(); const tracker = new NotificationTracker(deliver, read);
    const pending = state({ status: "waiting-approval", pendingTools: [{ id: "t", name: "shell", stepIndex: 0 }] });
    tracker.handle(update(state({ status: "completed" })));
    expect(deliver).not.toHaveBeenCalled();
    tracker.handle(snapshot([pending]));
    expect(deliver).toHaveBeenLastCalledWith("server", pending, false);
    tracker.handle(update(state({ status: "completed" }), 9));
    tracker.handle({ type: "resource-changed", id: 15, resource: "settings" });
    expect(deliver).toHaveBeenCalledTimes(1);
    tracker.handle(update(pending));
    expect(deliver).toHaveBeenLastCalledWith("server", pending, false);
    const next = { ...pending, pendingTools: [{ id: "next", name: "shell", stepIndex: 1 }] };
    tracker.handle(update(next, 12));
    expect(deliver).toHaveBeenLastCalledWith("server", next, true);
    tracker.handle(update(state({ status: "completed" }), 13));
    expect(deliver).toHaveBeenLastCalledWith("server", expect.objectContaining({ status: "completed" }), true);
    tracker.handle(update(state({ status: "completed" }), 14));
    expect(deliver).toHaveBeenLastCalledWith("server", expect.anything(), false);
  });

  it("recovers interruptions after restart even when the server event counter resets", async () => {
    const deliver = vi.fn(); const read = vi.fn().mockResolvedValue(makeGeneration({ status: "interrupted" }));
    const tracker = new NotificationTracker(deliver, read);
    tracker.handle(snapshot([state()]));
    tracker.handle(snapshot([], 0));
    await vi.waitFor(() => expect(deliver).toHaveBeenLastCalledWith("server", expect.objectContaining({ status: "interrupted" }), true));
    tracker.handle(update(state({ generationId: "new", status: "failed" }), 1));
    expect(deliver).toHaveBeenLastCalledWith("server", expect.objectContaining({ generationId: "new" }), true);
    expect(read).toHaveBeenCalledWith("g");
  });

  it.each(["live", "deletion", "logout", "source"])("discards stale reconnect reads after %s", async (change) => {
    let finish!: (value: ReturnType<typeof makeGeneration>) => void;
    const deliver = vi.fn(); const tracker = new NotificationTracker(deliver, () => new Promise((resolve) => { finish = resolve; }));
    tracker.handle(snapshot([state()])); tracker.handle(snapshot([], 20));
    if (change === "live") tracker.handle(update(state({ status: "stopped" }), 21));
    if (change === "deletion") tracker.forget(["c"]);
    if (change === "logout") tracker.reset();
    if (change === "source") tracker.handle(snapshot([], 0, "different-server"));
    deliver.mockClear(); finish(makeGeneration({ status: "failed" }));
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retries failed reconciliation on the next snapshot and notifies new pending work on reconnect", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(makeGeneration({ status: "completed" }));
    const deliver = vi.fn(); const tracker = new NotificationTracker(deliver, read);
    tracker.handle(snapshot([state()])); tracker.handle(snapshot([], 20));
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    tracker.handle(snapshot([], 21));
    await vi.waitFor(() => expect(deliver).toHaveBeenLastCalledWith("server", expect.objectContaining({ status: "completed" }), true));
    const pending = state({ generationId: "new", status: "waiting-approval", pendingTools: [{ id: "tool", name: "tool", stepIndex: 2 }] });
    tracker.handle(snapshot([pending], 22));
    expect(deliver).toHaveBeenLastCalledWith("server", pending, true);
  });

  it("bounds terminal history while retaining active generations", () => {
    const read = vi.fn().mockResolvedValue(makeGeneration({ status: "completed" }));
    const tracker = new NotificationTracker(vi.fn(), read);
    tracker.handle(snapshot([state()]));
    for (let i = 11; i < 1020; i++) tracker.handle(update(state({ generationId: String(i), status: "completed" }), i));
    tracker.handle(snapshot([], 1021));
    expect(read).toHaveBeenCalledExactlyOnceWith("g");
  });
});

it("formats one notice per approval batch and excludes manual stops and Steer", () => {
  const notices = generationNotices("s", state({ status: "waiting-approval", pendingTools: [
    { id: "a", name: "读文件", stepIndex: 0 }, { id: "b", name: "写文件", stepIndex: 0 }, { id: "c", name: "shell", stepIndex: 1 }
  ] }));
  expect(notices).toHaveLength(2);
  expect(notices[0]?.body).toContain("读文件、写文件（2 项）");
  expect(generationNotices("s", state({ status: "stopped" }))).toEqual([]);
  expect(generationNotices("s", state({ status: "completed", stopReason: "steered" }))).toEqual([]);
  expect(generationNotices("s", state({ status: "failed" }))[0]?.title).toBe("生成失败");
});
