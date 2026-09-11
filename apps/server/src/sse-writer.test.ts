import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseWriter } from "./sse-writer";

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  write = vi.fn((_frame: string) => true);
  end = vi.fn(() => { this.writableEnded = true; this.emit("finish"); });
  destroy = vi.fn(() => { this.destroyed = true; this.emit("close"); });
}
afterEach(() => vi.useRealTimers());
describe("SSE resource bounds", () => {
  it("pauses writes until drain, preserves frame ordering and finishes after the last frame", () => {
    const response = new Response(); response.write.mockReturnValueOnce(false);
    const cleanup = vi.fn();
    const writer = new SseWriter(response as unknown as ServerResponse); writer.addCleanup(cleanup);
    writer.send("snapshot"); writer.send("delta"); writer.send("terminal"); writer.end();
    expect(response.write).toHaveBeenCalledTimes(1); expect(response.end).not.toHaveBeenCalled();
    response.emit("drain");
    expect(response.write.mock.calls.map(([frame]) => frame)).toEqual(["snapshot", "delta", "terminal"]);
    expect(response.end).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
    expect(response.eventNames()).toEqual([]); expect(writer.bufferedBytes).toBe(0);
  });
  it("accepts a large standalone snapshot but disconnects an overflowing slow consumer", () => {
    const response = new Response(); response.write.mockReturnValue(false);
    const closed = vi.fn(); const writer = new SseWriter(response as unknown as ServerResponse, closed);
    writer.send("x".repeat(3 * 1024 * 1024));
    expect(writer.closed).toBe(false);
    writer.send("x".repeat(2 * 1024 * 1024)); writer.send("é");
    expect(closed).toHaveBeenCalledWith("queue-overflow"); expect(writer.bufferedBytes).toBe(0);
    const lateCleanup = vi.fn(); writer.addCleanup(lateCleanup); expect(lateCleanup).toHaveBeenCalledOnce();
  });
  it("cleans heartbeat, drain timeout and subscriptions on timeout or peer close", () => {
    vi.useFakeTimers();
    for (const reason of ["drain-timeout", "client-disconnected"]) {
      const response = new Response(); response.write.mockReturnValue(false);
      const closed = vi.fn(); const writer = new SseWriter(response as unknown as ServerResponse, closed);
      const cleanup = vi.fn(); writer.addCleanup(cleanup); writer.send("snapshot");
      if (reason === "client-disconnected") response.destroy(); else vi.advanceTimersByTime(15_000);
      expect(closed).toHaveBeenCalledWith(reason); expect(cleanup).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0); expect(response.eventNames()).toEqual([]);
    }
  });
});
