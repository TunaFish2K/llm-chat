import { requestRetries } from "./request-preferences";

export function retryDelay(attempt: number): number {
  return Math.min(4_000, attempt === 0 ? 500 : 1_500 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
}
export function retryWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const value = error as { status: number; code?: string };
  return value.status === 0 ? value.code !== "request_cancelled" : [408, 429, 500, 502, 503, 504].includes(value.status);
}
export async function retryRequest<T>(action: () => Promise<T>, signal: AbortSignal, maxRetries = requestRetries()): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await action(); }
    catch (error) {
      if (signal.aborted || attempt >= maxRetries || !retryable(error)) throw error;
      const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
      await retryWait(retryAfter !== undefined ? Math.min(10_000, Math.max(0, retryAfter)) : retryDelay(attempt), signal);
    }
  }
}
