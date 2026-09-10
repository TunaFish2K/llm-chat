import { afterEach, expect, it, vi } from "vitest";
import { startShutdownDeadline } from "./shutdown";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("forces a failed exit only after the fixed 30 second cleanup deadline", () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  startShutdownDeadline();
  vi.advanceTimersByTime(29_999);
  expect(exit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(exit).toHaveBeenCalledWith(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("30000ms"));
});

it("cancels the forced exit when cleanup finishes early", () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const clear = startShutdownDeadline();
  vi.advanceTimersByTime(100);
  clear();
  vi.advanceTimersByTime(30_000);
  expect(exit).not.toHaveBeenCalled();
});
