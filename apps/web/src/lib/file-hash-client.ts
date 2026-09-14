import { t } from "./i18n";

export function hashFileInWorker(file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  signal.throwIfAborted();
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
