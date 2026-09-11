import { afterEach, expect, it, vi } from "vitest";
import { RefreshScheduler } from "./refresh-scheduler";

afterEach(() => vi.useRealTimers());
it("coalesces bursts, follows up once during a read, and cancels queued work", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const action = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; })).mockResolvedValue(undefined);
  const scheduler = new RefreshScheduler(() => {});
  for (let i = 0; i < 100; i++) scheduler.schedule("chat", action);
  await vi.advanceTimersByTimeAsync(100); expect(action).toHaveBeenCalledOnce();
  for (let i = 0; i < 100; i++) scheduler.schedule("chat", action);
  resolve(); await vi.advanceTimersByTimeAsync(100); expect(action).toHaveBeenCalledTimes(2);
  scheduler.schedule("chat", action); scheduler.clear(); await vi.runAllTimersAsync();
  expect(action).toHaveBeenCalledTimes(2);
});
