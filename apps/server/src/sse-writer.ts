import type { ServerResponse } from "node:http";

const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 15_000;

/** Once the writable buffer fills, further frames enter a bounded queue,
 * including while a large initial snapshot is being drained. */
export class SseWriter {
  private readonly queue: string[] = [];
  private bytes = 0;
  private blocked = false;
  private ending = false;
  private disposed = false;
  private drainTimer: NodeJS.Timeout | undefined;
  private readonly cleanups: Array<() => void> = [];
  private readonly heartbeat: NodeJS.Timeout;
  private reason = "client-disconnected";

  constructor(private readonly response: ServerResponse, private readonly onClose: (reason: string) => void = () => {}) {
    response.on("drain", this.drain);
    response.once("close", this.cleanup);
    response.once("finish", this.cleanup);
    response.once("error", this.error);
    this.heartbeat = setInterval(() => {
      if (!this.blocked && !this.ending) this.send(": heartbeat\n\n");
    }, 15_000);
    this.heartbeat.unref();
  }

  get bufferedBytes(): number { return this.bytes + this.response.writableLength; }
  get closed(): boolean { return this.disposed; }
  addCleanup(cleanup: () => void): void {
    if (this.disposed) cleanup(); else this.cleanups.push(cleanup);
  }
  send(frame: string): void {
    if (this.disposed || this.ending) return;
    if (this.response.destroyed || this.response.writableEnded) { this.cleanup(); return; }
    if (this.blocked) {
      const size = Buffer.byteLength(frame);
      if (this.bytes + size > MAX_QUEUED_BYTES) { this.close("queue-overflow"); return; }
      this.queue.push(frame); this.bytes += size;
    } else this.write(frame);
  }
  end(): void {
    if (this.disposed) return;
    this.ending = true; this.reason = "generation-ended";
    if (!this.blocked && !this.queue.length) this.response.end();
  }
  close(reason = "shutdown"): void {
    if (this.disposed) return;
    this.reason = reason;
    this.cleanup(); this.response.destroy();
  }
  private write(frame: string): void {
    try {
      if (!this.response.write(frame)) {
        this.blocked = true;
        this.drainTimer = setTimeout(() => this.close("drain-timeout"), DRAIN_TIMEOUT_MS);
        this.drainTimer.unref();
      }
    } catch { this.close("write-error"); }
  }
  private readonly drain = (): void => {
    if (this.disposed) return;
    clearTimeout(this.drainTimer); this.drainTimer = undefined; this.blocked = false;
    while (!this.blocked && !this.disposed && this.queue.length) {
      const frame = this.queue.shift()!;
      this.bytes -= Buffer.byteLength(frame); this.write(frame);
    }
    if (this.ending && !this.blocked && !this.disposed) this.response.end();
  };
  private readonly error = (): void => { this.close("write-error"); };
  private readonly cleanup = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat); clearTimeout(this.drainTimer);
    this.queue.length = 0; this.bytes = 0;
    this.response.off("drain", this.drain);
    this.response.off("close", this.cleanup);
    this.response.off("finish", this.cleanup);
    this.response.off("error", this.error);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.onClose(this.reason);
  };
}
