import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerResourceFile } from "@llm-chat/contracts";

export function waitForResource<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

type Transfer = { controller: AbortController; promise: Promise<void>; listeners: Set<(bytes: number) => void> };
export class ContainerResourceFiles {
  private readonly transfers = new Map<string, Transfer>();
  constructor(readonly directory: string, private readonly fetcher: typeof fetch = fetch) {}
  path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid resource digest");
    return join(this.directory, hash);
  }
  async has(file: ContainerResourceFile): Promise<boolean> {
    return (await stat(this.path(file.sha256)).catch(() => null))?.size === file.size;
  }
  async bytes(): Promise<number> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const sizes = await Promise.all(names.map(name => stat(join(this.directory, name)).then(value => value.size).catch(() => 0)));
    return sizes.reduce((sum, size) => sum + size, 0);
  }
  async ensure(file: ContainerResourceFile, url: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    signal.throwIfAborted();
    if (await this.has(file)) { progress(file.size); return; }
    let transfer = this.transfers.get(file.sha256);
    if (transfer?.controller.signal.aborted) { await transfer.promise.catch(() => {}); transfer = undefined; }
    if (!transfer) {
      const controller = new AbortController();
      const listeners = new Set<(bytes: number) => void>();
      const promise = this.download(file, url, controller.signal, bytes => listeners.forEach(listener => listener(bytes)))
        .finally(() => this.transfers.delete(file.sha256));
      promise.catch(() => {});
      transfer = { controller, promise, listeners };
      this.transfers.set(file.sha256, transfer);
    }
    transfer.listeners.add(progress);
    try { await waitForResource(transfer.promise, signal); progress(file.size); }
    finally {
      transfer.listeners.delete(progress);
      if (!transfer.listeners.size) transfer.controller.abort();
    }
  }
  private async download(file: ContainerResourceFile, url: string, signal: AbortSignal, progress: (bytes: number) => void) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(file.sha256);
    const partial = destination + ".part";
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        let offset = (await stat(partial).catch(() => null))?.size ?? 0;
        if (offset > file.size) { await rm(partial, { force: true }); offset = 0; }
        if (offset < file.size) {
          const timeout = new AbortController();
          let timer = setTimeout(() => timeout.abort(new Error("Resource connection timed out")), 30_000);
          const progressDeadline = () => {
            clearTimeout(timer);
            timer = setTimeout(() => timeout.abort(new Error("Resource download stalled")), 120_000);
          };
          try {
          const response = await this.fetcher(url, { signal: AbortSignal.any([signal, timeout.signal]), headers: offset ? { Range: `bytes=${offset}-` } : {} });
          progressDeadline();
          if (response.status === 416) { await response.body?.cancel(); await rm(partial, { force: true }); throw new Error("Download range changed; retrying"); }
          if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download failed: HTTP ${response.status} (${file.name})`); }
          if (response.status === 206 && !response.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) {
            await response.body.cancel(); throw new Error("Invalid download range");
          }
          if (response.status !== 206) offset = 0;
          const output = await open(partial, offset ? "a" : "w", 0o600);
          try {
            const reader = response.body.getReader();
            try { while (true) {
              const next = await reader.read();
              if (next.done) break;
              const chunk = next.value;
              progressDeadline();
              signal.throwIfAborted();
              if (offset + chunk.length > file.size) throw new Error(`Resource exceeds expected size: ${file.name}`);
              await output.writeFile(chunk); offset += chunk.length; progress(offset);
            } } finally { await reader.cancel(); reader.releaseLock(); }
          } finally { await output.close(); }
          } finally { clearTimeout(timer); }
        }
        if (offset !== file.size || await fileHash(partial) !== file.sha256) {
          await rm(partial, { force: true }); throw new Error(`Resource checksum mismatch: ${file.name}`);
        }
        await rename(partial, destination); return;
      } catch (error) { last = error; }
    }
    throw last;
  }
  async close() {
    const transfers = [...this.transfers.values()];
    transfers.forEach(transfer => transfer.controller.abort());
    await Promise.allSettled(transfers.map(transfer => transfer.promise));
  }
}
