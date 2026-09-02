import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeAppEvents, subscribeGeneration } from "./sse";
import { FakeEventSource } from "../../test/setup";

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

    subscription.close();
    subscription.close();
    expect(source.closed).toBe(true);
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

    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(499);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    subscription.close();
  });

  it("does not reconnect after a terminal status or explicit close", () => {
    vi.useFakeTimers();
    const subscription = subscribeGeneration("generation", vi.fn());
    const source = FakeEventSource.instances[0]!;
    source.emit("status", { type: "status", status: "completed" });
    source.onerror?.();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();

    const active = subscribeGeneration("other", vi.fn());
    const other = FakeEventSource.instances[1]!;
    other.onerror?.();
    active.close();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
