import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeAppEvents, subscribeGeneration } from "./sse";
import { FakeEventSource } from "../../test/setup";
import { SERVER_CHANNELS_KEY } from "./server-channel";

// jsdom pages load from http://localhost:3000; another port is a same-site channel.
const CHANNEL = "http://localhost:4000";
function useChannel(boundServerId = "server") {
  localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify({ channels: [CHANNEL], active: CHANNEL, boundServerId }));
  window.dispatchEvent(new StorageEvent("storage", { key: SERVER_CHANNELS_KEY }));
}

describe("subscribeAppEvents", () => {
  it("creates a single EventSource and keeps it across transient errors", () => {
    const onEvent = vi.fn();
    const onState = vi.fn();
    const subscription = subscribeAppEvents(onEvent, onState);

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/events");

    // A transient error must not close or recreate the source: the browser
    // retries natively with its Last-Event-ID, preserving server replay.
    source.onerror?.();
    expect(onState).toHaveBeenLastCalledWith(false);
    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    source.onopen?.();
    expect(onState).toHaveBeenLastCalledWith(true);

    source.emit("task", { id: 7, type: "task", taskId: "t1", task: { id: "t1", status: "running" } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 7, taskId: "t1" }));
    source.emit("message-queue", { id: 8, type: "message-queue", conversationId: "c1" });
    expect(onEvent).toHaveBeenLastCalledWith({ id: 8, type: "message-queue", conversationId: "c1" });
    source.emit("image-session-generation", {
      id: 9, type: "image-session-generation", jobId: "job", imageSessionId: "session", imageNodeId: "node", job: {}
    });
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "image-session-generation", imageSessionId: "session", imageNodeId: "node"
    }));

    subscription.close();
    subscription.close();
    expect(source.closed).toBe(true);
    onEvent.mockClear(); onState.mockClear();
    source.emit("resync", { id: 10, type: "resync" });
    source.onopen?.(); source.onerror?.();
    expect(onEvent).not.toHaveBeenCalled(); expect(onState).not.toHaveBeenCalled();
  });
});

describe("subscribeGeneration", () => {
  afterEach(() => vi.useRealTimers());

  it("reconnects an active stream with backoff", () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onDisconnect = vi.fn();
    const subscription = subscribeGeneration("generation", onEvent, onDisconnect);
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.emit("block-delta", { type: "block-delta", blockId: "block", delta: "hi" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "block-delta" }));

    for (const listener of first.listeners.get("error") ?? []) {
      expect(() => listener(new Event("error") as MessageEvent)).not.toThrow();
    }

    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(499);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    onEvent.mockClear();
    first.emit("status", { type: "status", status: "failed" });
    first.onerror?.();
    expect(onEvent).not.toHaveBeenCalled();
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    subscription.close();
  });

  it.each(["waiting-approval", "completed"] as const)("does not reconnect after a %s status", (status) => {
    vi.useFakeTimers();
    const subscription = subscribeGeneration("generation", vi.fn());
    const source = FakeEventSource.instances[0]!;
    source.emit("status", { type: "status", status });
    source.onerror?.();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });

  it("does not reconnect after explicit close", () => {
    vi.useFakeTimers();
    const active = subscribeGeneration("other", vi.fn());
    const other = FakeEventSource.instances[0]!;
    other.onerror?.();
    active.close();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("does not reconnect after receiving a completed snapshot", () => {
    vi.useFakeTimers();
    const subscription = subscribeGeneration("finished", vi.fn());
    const source = FakeEventSource.instances[0]!;
    source.emit("snapshot", { type: "snapshot", generation: { status: "completed" } });
    source.onerror?.(); vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });
});

describe("server channels", () => {
  afterEach(() => vi.useRealTimers());

  it("opens credentialed streams on the active channel after it proves the server identity", async () => {
    useChannel();
    const fetcher = vi.fn(async () => Response.json({ id: "server" }));
    vi.stubGlobal("fetch", fetcher);
    const app = subscribeAppEvents(vi.fn());
    const generation = subscribeGeneration("generation", vi.fn());
    expect(FakeEventSource.instances).toHaveLength(0);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances.map((source) => [source.url, source.withCredentials])).toEqual([
      [`${CHANNEL}/api/events`, true], [`${CHANNEL}/api/generations/generation/events`, true]
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    app.close(); generation.close();
  });

  it("never opens a stream on a channel of another server and retries unreachable ones", async () => {
    useChannel("other");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "server" })));
    const mismatch = subscribeAppEvents(vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeEventSource.instances).toHaveLength(0);
    mismatch.close();

    vi.useFakeTimers();
    useChannel();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(Response.json({ id: "server" })));
    const onState = vi.fn();
    const app = subscribeAppEvents(vi.fn(), onState);
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    app.close();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(Response.json({ id: "server" })));
    useChannel();
    const onDisconnect = vi.fn();
    const generation = subscribeGeneration("generation", vi.fn(), onDisconnect);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDisconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeEventSource.instances).toHaveLength(2);
    generation.close();
  });
});
