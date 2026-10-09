import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const heap = { used_heap_size: 0, heap_size_limit: 1000 * 1024 * 1024 };
vi.mock("node:v8", async (importOriginal) => ({ ...await importOriginal<typeof import("node:v8")>(), getHeapStatistics: () => heap }));
const { enableFatalReports, watchMemory } = await import("./memory-watch");

afterEach(() => { vi.useRealTimers(); });

it("warns once when the heap nears its limit and notes recovery", () => {
  vi.useFakeTimers();
  const log = { warn: vi.fn(), info: vi.fn() };
  const stop = watchMemory(log, () => ({ activeGenerations: 2 }), { intervalMs: 1000 });
  heap.used_heap_size = 500 * 1024 * 1024; vi.advanceTimersByTime(1000);
  expect(log.warn).not.toHaveBeenCalled();
  heap.used_heap_size = 850 * 1024 * 1024; vi.advanceTimersByTime(2000);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0]![0]).toMatchObject({ heapUsedMiB: 850, heapLimitMiB: 1000, activeGenerations: 2 });
  heap.used_heap_size = 600 * 1024 * 1024; vi.advanceTimersByTime(1000);
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ heapUsedMiB: 600 }), "heap usage recovered");
  stop(); heap.used_heap_size = 990 * 1024 * 1024; vi.advanceTimersByTime(5000);
  expect(log.warn).toHaveBeenCalledTimes(1);
});

it("enables fatal error reports in the data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-chat-report-"));
  const previous = { directory: process.report.directory, fatal: process.report.reportOnFatalError };
  try {
    expect(enableFatalReports(root)).toBe(join(root, "diagnostics"));
    expect(process.report.reportOnFatalError).toBe(true);
    writeFileSync(join(root, "blocked"), "");
    expect(enableFatalReports(join(root, "blocked"))).toBeNull();
  } finally {
    process.report.directory = previous.directory;
    process.report.reportOnFatalError = previous.fatal;
    rmSync(root, { recursive: true, force: true });
  }
});
