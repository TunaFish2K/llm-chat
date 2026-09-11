/** Coalesce bursts and allow at most one follow-up while a read is running. */
export class RefreshScheduler {
  private readonly jobs = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; running: boolean; again: boolean; action: () => Promise<unknown> }>();
  constructor(private readonly onError: (error: unknown) => void, private readonly delay = 100) {}
  schedule(key: string, action: () => Promise<unknown>): void {
    const existing = this.jobs.get(key);
    if (existing) { existing.action = action; if (existing.running) existing.again = true; return; }
    const job = { running: false, again: false, action, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.jobs.set(key, job);
    const run = async () => {
      job.timer = undefined; job.running = true; job.again = false;
      try { await job.action(); } catch (error) { this.onError(error); }
      finally {
        job.running = false;
        if (this.jobs.get(key) !== job) return;
        if (job.again) job.timer = setTimeout(() => void run(), this.delay);
        else this.jobs.delete(key);
      }
    };
    job.timer = setTimeout(() => void run(), this.delay);
  }
  clear(): void { for (const job of this.jobs.values()) clearTimeout(job.timer); this.jobs.clear(); }
}
