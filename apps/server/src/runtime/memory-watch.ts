import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getHeapStatistics } from "node:v8";

interface MemoryLogger {
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
}

const MiB = 1024 * 1024;

/**
 * Writes a small Node diagnostic report (heap statistics and the JavaScript
 * stack) to `<dataDir>/diagnostics` when the process dies from a fatal error such
 * as running out of heap.
 */
export function enableFatalReports(dataDir: string): string | null {
  const directory = resolve(dataDir, "diagnostics");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.report.directory = directory;
    process.report.reportOnFatalError = true;
    return directory;
  } catch {
    return null;
  }
}

/**
 * Samples heap use and warns once per climb above `threshold` of the V8 heap
 * limit, so an approaching OOM shows up in logs with what was running.
 */
export function watchMemory(log: MemoryLogger, activity: () => Record<string, number>, options: { intervalMs?: number; threshold?: number } = {}): () => void {
  const threshold = options.threshold ?? 0.8;
  let warned = false;
  const sample = () => {
    const { used_heap_size: used, heap_size_limit: limit } = getHeapStatistics();
    const ratio = used / limit;
    if (ratio >= threshold && !warned) {
      warned = true;
      const memory = process.memoryUsage();
      log.warn({
        heapUsedMiB: Math.round(used / MiB),
        heapLimitMiB: Math.round(limit / MiB),
        rssMiB: Math.round(memory.rss / MiB),
        externalMiB: Math.round(memory.external / MiB),
        arrayBuffersMiB: Math.round(memory.arrayBuffers / MiB),
        ...activity()
      }, "heap usage is close to the V8 limit");
    } else if (ratio < threshold * 0.9 && warned) {
      warned = false;
      log.info({ heapUsedMiB: Math.round(used / MiB), heapLimitMiB: Math.round(limit / MiB) }, "heap usage recovered");
    }
  };
  const timer = setInterval(sample, options.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
