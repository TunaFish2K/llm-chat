import { afterEach, expect, it, vi } from "vitest";
import { noteInteraction, scheduleBackgroundTask } from "./background-task";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("defers history during input, checks the idle budget, and cancels queued work", () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  let idle: IdleRequestCallback | undefined;
  const cancelIdle = vi.fn();
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => { idle = callback; return 1; });
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  const action = vi.fn();
  noteInteraction();
  const cancel = scheduleBackgroundTask(action);
  vi.advanceTimersByTime(599); expect(idle).toBeUndefined();
  vi.advanceTimersByTime(1); idle!({ timeRemaining: () => 1, didTimeout: false });
  expect(action).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  noteInteraction(); idle!({ timeRemaining: () => 10, didTimeout: false });
  vi.advanceTimersByTime(600); idle!({ timeRemaining: () => 10, didTimeout: false });
  expect(action).toHaveBeenCalledOnce();
  cancel(); expect(cancelIdle).toHaveBeenCalledWith(1);
  const stopped = scheduleBackgroundTask(action); stopped(); vi.runAllTimers();
  expect(action).toHaveBeenCalledOnce();
});

it("yields with a timer on browsers without idle callbacks and respects cancellation", () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestIdleCallback", undefined);
  const action = vi.fn();
  scheduleBackgroundTask(action); vi.runAllTimers(); expect(action).toHaveBeenCalledOnce();
  const cancel = scheduleBackgroundTask(action); cancel(); vi.runAllTimers();
  expect(action).toHaveBeenCalledOnce();
});
