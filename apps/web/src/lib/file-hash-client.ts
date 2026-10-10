import { t } from "./i18n";

/** Native SHA-256 needs the whole file in memory, so it is only used below this size. */
const NATIVE_HASH_MAX_BYTES = 64 * 1024 ** 2;

export async function hashFileInWorker(file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  signal.throwIfAborted();
  // Typical photos skip the worker start-up entirely; the digest itself runs off the main thread.
  if (file.size <= NATIVE_HASH_MAX_BYTES && globalThis.crypto?.subtle) {
    let digest: ArrayBuffer;
    try { digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); }
    catch { throw new Error(t("uploads.read_failed")); }
    signal.throwIfAborted();
    progress(file.size);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./file-hash.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const fail = () => { cleanup(); reject(new Error(t("uploads.read_failed"))); };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = fail;
    worker.onmessage = (event: MessageEvent<{ bytes?: number; sha256?: string; error?: boolean }>) => {
      if (event.data.error) return fail();
      if (event.data.sha256) { cleanup(); resolve(event.data.sha256); }
      else if (event.data.bytes !== undefined) progress(event.data.bytes);
    };
    worker.postMessage(file);
  });
}
