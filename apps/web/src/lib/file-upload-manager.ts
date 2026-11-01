import { errorI18n } from "@llm-chat/i18n";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_ATTACHMENT_BYTES, imageUploadLimits, type FileAssetDto, type FileUploadDto } from "@llm-chat/contracts";
import { fileUploadHttp, type FileUploadHttp } from "./file-upload-http";
import { hashFileInWorker } from "./file-hash-client";
import { formatBytes } from "./format";
import { createStore } from "./store";
import { draftAttachmentsForScope, updateDraftAttachments } from "./composer-draft-storage";
import { conversationDeleted } from "./conversation-lifecycle";
import { FileUploadDatabase, MAX_CACHED_UPLOAD_BYTES, type StoredUploadTask, type UploadPersistence, type UploadSession } from "./file-upload-db";
import { t } from "./i18n";
import { requestRetries } from "./request-preferences";
import { retryable, retryDelay } from "./request-retry";

export type UploadStatus = "queued" | "saving" | "restoring" | "hashing" | "uploading" | "checking" | "waiting" | "needs-file" | "failed";
export interface UploadTask {
  id: string; fileName: string; mimeType: string; byteSize: number; image: boolean;
  sha256?: string; created: boolean; offset: number; hashedBytes: number;
  remoteId?: string;
  status: UploadStatus; error: string | null;
  cached?: boolean | undefined; cacheWarning?: boolean | undefined;
  file?: File | undefined; verified?: boolean | undefined; controller?: AbortController | undefined;
}
export interface UploadScope {
  id: string; conversationId?: string | undefined; attachments: FileAssetDto[]; tasks: UploadTask[];
}
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const KEY = "llm-chat.uploads.v1";
const CHECK_DELAYS_MS = [100, 200, 500];
/** "image" sends a picture to the model; "file" keeps it as an attachment outside the context. */
export type UploadIntent = "image" | "file";

export function uploadDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
interface Dependencies {
  http: FileUploadHttp;
  hash: typeof hashFileInWorker;
  imageLimits: () => { image: number; message: number };
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  changed: () => void;
  /** Progress ticks; may be coalesced, unlike `changed`, which callers read back immediately. */
  progressed?: () => void;
  attach: (scope: string, assets: FileAssetDto[]) => void;
  delay: typeof uploadDelay;
  online: () => boolean;
  persistence?: UploadPersistence;
}
export class FileUploadManager {
  private scopes = new Map<string, UploadScope>();
  private sourceId = "local";
  private sourceKnown = false;
  private active = 0;
  private enabled = true;
  private suspended = false;
  private session: UploadSession | undefined;
  private opening: Promise<void> | undefined;
  private cleanup: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private sourceConfirmed = false;
  private openedSource: string | undefined;
  private records = new Set<string>();
  private owners = new Map<UploadTask, UploadSession>();
  private writes = new Map<string, Promise<boolean>>();
  private wakeTimers = new Map<UploadTask, ReturnType<typeof setTimeout>>();
  private cancelled = new Set<string>();
  private removedConversations = new Set<string>();
  private staging = new Set<UploadTask>();
  constructor(private readonly deps: Dependencies) {
    try {
      const saved = JSON.parse(deps.storage.getItem(KEY) ?? "null");
      if (saved && typeof saved.sourceId === "string" && Array.isArray(saved.scopes)) {
        this.sourceId = saved.sourceId;
        this.sourceKnown = true;
        for (const scope of saved.scopes as UploadScope[]) {
          if (typeof scope.id !== "string" || !Array.isArray(scope.tasks) || !Array.isArray(scope.attachments)) continue;
          scope.tasks = scope.tasks.filter((task) => typeof task.id === "string" && typeof task.fileName === "string" && task.byteSize > 0 && task.byteSize <= MAX_ATTACHMENT_FILE_BYTES)
            .slice(0, 8).map((task) => ({ ...task, cached: false, file: undefined, controller: undefined, verified: false, status: "needs-file" }));
          this.scopes.set(scope.id, scope);
        }
      }
    } catch { /* A damaged or unavailable local record never blocks a new upload. */ }
  }
  ensure(id: string, initial: FileAssetDto[], conversationId?: string): UploadScope {
    let scope = this.scopes.get(id);
    if (!scope) { scope = { id, attachments: initial, tasks: [], conversationId }; this.scopes.set(id, scope); }
    return scope;
  }
  all(): UploadScope[] { return [...this.scopes.values()]; }
  setSource(id: string): void {
    if (this.sourceId !== id) { if (this.sourceKnown || !this.deps.persistence) this.reset(); this.sourceId = id; }
    this.sourceKnown = true;
    this.enabled = true;
    this.suspended = false;
    this.sourceConfirmed = true;
    if (this.deps.persistence && this.openedSource !== id) this.restore(id);
    for (const scope of this.scopes.values()) for (const task of scope.tasks) {
      if (task.created && task.status === "needs-file") task.status = "queued";
    }
    this.changed(); this.pump();
  }
  /** Startup callers stay synchronous; tests and lifecycle cleanup can await restoration. */
  async ready(): Promise<void> { await this.opening; }
  /** Page transitions release leases without deleting the resumable queue. */
  suspend(): void {
    if (!this.enabled) return;
    this.enabled = false; this.suspended = true;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) {
      if (task.controller) { task.status = "queued"; task.controller.abort(); }
    }
    // Start the release transaction during pagehide; unload may discard promise continuations.
    for (const [task, session] of this.owners) void session.release(task.id).catch(() => {});
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear(); this.changed();
  }
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false; this.enabled = true;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) if (task.status === "waiting") task.status = "queued";
    this.pump();
  }
  private restore(sourceId: string): void {
    const generation = this.generation;
    this.openedSource = sourceId;
    this.opening = (async () => {
      await this.cleanup;
      const session = await this.deps.persistence!.open(sourceId);
      if (generation !== this.generation) { await session.clear(); return; }
      this.session = session;
      const records = await session.list();
      if (generation !== this.generation) return;
      for (const row of records) {
        if (this.cancelled.has(row.id) || row.conversationId && (conversationDeleted(row.conversationId) || this.removedConversations.has(row.conversationId))) {
          await session.remove(row.id);
          if (generation !== this.generation) return;
          continue;
        }
        const scope = this.ensure(row.scopeId, draftAttachmentsForScope(row.scopeId) ?? row.attachments, row.conversationId);
        const existing = scope.tasks.find((task) => task.id === row.id);
        const task: UploadTask = { ...row.task, cached: row.cached, file: existing?.file, verified: false,
          status: row.cached || row.task.created || existing?.file ? "queued" : "needs-file" };
        if (existing) Object.assign(existing, task); else scope.tasks.push(task);
        this.records.add(task.id);
      }
      // Import the old per-tab receipts. Earlier versions did not retain file contents.
      for (const scope of this.scopes.values()) for (const task of scope.tasks) {
        if (this.records.has(task.id)) continue;
        if (await this.save(session, scope, task)) this.records.add(task.id);
        if (generation !== this.generation) return;
      }
      try { this.deps.storage.removeItem(KEY); } catch {}
    })().catch(() => {
      if (generation !== this.generation) return;
      this.session = undefined;
      for (const scope of this.scopes.values()) for (const task of scope.tasks) this.warnCache(task);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.opening = undefined;
      for (const scope of this.scopes.values()) for (const task of scope.tasks) {
        if (task.file && !task.cached) void this.stage(scope, task);
      }
      this.changed(); this.pump();
    });
  }
  /** Persist every selected file, including those waiting behind the two network slots. */
  private async stage(scope: UploadScope, task: UploadTask): Promise<void> {
    const session = this.session;
    if (!session || this.staging.has(task)) return;
    this.staging.add(task); task.status = "saving"; this.changed();
    try {
      const file = task.byteSize <= MAX_CACHED_UPLOAD_BYTES ? task.file : undefined;
      if (await this.save(session, scope, task, file) && this.current(scope, task)) {
        this.records.add(task.id); task.cached = Boolean(file);
        if (file) task.cacheWarning = false;
      }
    } catch { this.warnCache(task); }
    finally {
      this.staging.delete(task);
      if (this.current(scope, task)) { task.status = "queued"; this.changed(); this.pump(); }
    }
  }
  private storedTask(task: UploadTask): StoredUploadTask {
    const { file: _file, controller: _controller, verified: _verified, cached: _cached, cacheWarning: _warning, ...stored } = task;
    return { ...stored };
  }
  private save(session: UploadSession, scope: UploadScope, task: UploadTask, file?: Blob): Promise<boolean> {
    const stored = this.storedTask(task);
    const snapshot = { ...scope, attachments: [...scope.attachments] };
    const next = (this.writes.get(task.id) ?? Promise.resolve()).catch(() => false)
      .then(() => session.put(snapshot, stored, file));
    this.writes.set(task.id, next);
    void next.finally(() => { if (this.writes.get(task.id) === next) this.writes.delete(task.id); }).catch(() => {});
    return next;
  }
  private forget(session: UploadSession | undefined, task: UploadTask): Promise<void> {
    this.records.delete(task.id);
    this.owners.delete(task);
    clearTimeout(this.wakeTimers.get(task)); this.wakeTimers.delete(task);
    return (this.writes.get(task.id) ?? Promise.resolve()).catch(() => false).then(() => session?.remove(task.id));
  }
  private warnCache(task: UploadTask): void {
    if (this.deps.persistence && task.byteSize <= MAX_CACHED_UPLOAD_BYTES) {
      task.cacheWarning = true; this.deps.changed();
    }
  }
  /** Progress ticks only repaint; the stored queue changes on status transitions. */
  private progressed(): void { (this.deps.progressed ?? this.deps.changed)(); }
  private changed(): void {
    try {
      if (this.session) this.deps.storage.removeItem(KEY);
      else this.deps.storage.setItem(KEY, JSON.stringify({ sourceId: this.sourceId, scopes: this.all().map((scope) => ({
        ...scope, tasks: scope.tasks.map(({ file: _file, controller: _controller, verified: _verified, ...task }) => task)
      })) }));
    } catch { if (typeof window !== "undefined") window.dispatchEvent(new Event("llm-chat:draft-storage-unavailable")); }
    for (const [task, session] of this.owners) {
      const scope = this.all().find((item) => item.tasks.includes(task));
      if (scope) void this.save(session, scope, task).catch(() => this.warnCache(task));
    }
    this.deps.changed();
  }
  setAttachments(id: string, assets: FileAssetDto[]): void {
    const scope = this.scopes.get(id)!;
    scope.attachments = assets;
    this.deps.attach(id, assets);
    this.changed();
  }
  /** Without an intent, pasted or dropped pictures are sent as images and everything else as files. */
  enqueue(id: string, files: File[], intent?: UploadIntent): string[] {
    if (!this.enabled) return [t("error.authentication_required")];
    const scope = this.scopes.get(id)!;
    const errors: string[] = [];
    const added: UploadTask[] = [];
    const limits = this.deps.imageLimits();
    for (const file of files) {
      const pending = scope.tasks.map((task) => ({ byteSize: task.byteSize, kind: task.image ? "image" : "file" }));
      const all = [...scope.attachments, ...pending];
      const image = intent ? intent === "image" : IMAGE_TYPES.has(file.type);
      if (all.length >= 8) { errors.push(t("AttachmentEditor.attach_up_to_8_files_per_message")); break; }
      if (image && !IMAGE_TYPES.has(file.type)) { errors.push(t("uploads.image_type")); continue; }
      if (!file.size || file.size > (image ? limits.image : MAX_ATTACHMENT_FILE_BYTES)) {
        errors.push(image ? t("uploads.image_limit_size", { size: formatBytes(limits.image) }) : t("uploads.file_limit")); continue;
      }
      const images = all.filter((asset) => asset.kind === "image");
      if (image && (images.length >= MAX_IMAGES_PER_MESSAGE || images.reduce((sum, asset) => sum + asset.byteSize, 0) + file.size > limits.message)) {
        errors.push(t("AttachmentEditor.attach_up_to_4_images_per_message_with_a_total", { size: formatBytes(limits.message) })); continue;
      }
      if (all.reduce((sum, asset) => sum + asset.byteSize, 0) + file.size > MAX_MESSAGE_ATTACHMENT_BYTES) { errors.push(t("uploads.message_limit")); continue; }
      const task: UploadTask = { id: crypto.randomUUID(), fileName: file.name || "file", mimeType: file.type || "application/octet-stream", byteSize: file.size,
        image, created: false, offset: 0, hashedBytes: 0, file, status: "queued", error: null };
      scope.tasks.push(task); added.push(task);
    }
    if (!this.opening) for (const task of added) void this.stage(scope, task);
    this.changed(); this.pump(); return errors;
  }
  retry(id: string, taskId: string, file?: File): void {
    const task = this.scopes.get(id)?.tasks.find((item) => item.id === taskId);
    if (!task || task.controller) return;
    if (file) { task.file = file; task.verified = false; task.cached = false; task.cacheWarning = false; }
    task.error = null; task.status = "queued";
    this.changed(); this.pump();
  }
  cancel(id: string, taskId: string): void {
    const scope = this.scopes.get(id);
    const task = scope?.tasks.find((item) => item.id === taskId);
    if (!scope || !task) return;
    task.controller?.abort();
    this.cancelled.add(task.id);
    scope.tasks = scope.tasks.filter((item) => item !== task);
    void this.forget(this.session, task).catch(() => {});
    // The create response might have been lost; deletion is idempotent even without created=true.
    if (task.sha256) void this.deps.http.cancel(task.remoteId ?? task.id, AbortSignal.timeout(15_000)).catch(() => {});
    this.changed();
  }
  removeConversation(conversationId: string): void {
    this.removedConversations.add(conversationId);
    for (const scope of this.scopes.values()) if (scope.conversationId === conversationId) {
      for (const task of [...scope.tasks]) this.cancel(scope.id, task.id);
      this.scopes.delete(scope.id);
    }
    this.changed();
  }
  reset(): void {
    this.generation++;
    this.enabled = false;
    this.suspended = false;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) task.controller?.abort();
    this.scopes.clear();
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear(); this.owners.clear(); this.records.clear(); this.writes.clear(); this.cancelled.clear(); this.removedConversations.clear(); this.staging.clear();
    const session = this.session;
    const opening = this.opening;
    // Reopening the same source waits for revocation of the previous session's writes.
    this.cleanup = Promise.allSettled([this.cleanup, opening]).then(() => session?.clear()).catch(() => {});
    this.session = undefined; this.opening = undefined; this.openedSource = undefined; this.sourceConfirmed = false;
    try { this.deps.storage.removeItem(KEY); } catch {}
    this.deps.changed();
  }
  private current(scope: UploadScope, task: UploadTask) { return this.scopes.get(scope.id) === scope && scope.tasks.includes(task); }
  private pump(): void {
    if (!this.enabled || this.opening || (this.deps.persistence && !this.sourceConfirmed)) return;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) {
      if (this.active >= 2) return;
      if (task.status !== "queued" || task.controller || this.staging.has(task)) continue;
      this.active++;
      const controller = new AbortController(); task.controller = controller;
      void this.execute(scope, task, controller).catch((error) => {
        if (!this.current(scope, task) || controller.signal.aborted) return;
        task.status = "failed"; task.error = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        task.controller = undefined; this.active--;
        if (this.current(scope, task)) this.changed();
        this.pump();
      });
    }
  }
  private async io<T>(task: UploadTask, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const maxRetries = requestRetries();
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const session = this.owners.get(task);
      if (session && !await session.renew(task.id).catch(() => { this.warnCache(task); return true; })) {
        const scope = this.all().find((item) => item.tasks.includes(task));
        if (scope) this.drop(scope, task);
        task.controller?.abort();
        throw new DOMException("Upload ownership changed", "AbortError");
      }
      signal.throwIfAborted();
      try { return await action(); }
      catch (error) {
        signal.throwIfAborted();
        if (attempt >= maxRetries || !retryable(error)) throw error;
        task.status = "waiting"; this.changed();
        const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
        await this.deps.delay(retryAfter !== undefined ? Math.min(10_000, Math.max(0, retryAfter)) : retryDelay(attempt), signal);
      }
    }
  }
  private drop(scope: UploadScope, task: UploadTask): void {
    if (!this.current(scope, task)) return;
    scope.tasks = scope.tasks.filter((item) => item !== task);
    this.owners.delete(task); this.records.delete(task.id);
    const attachments = draftAttachmentsForScope(scope.id);
    if (attachments) { scope.attachments = attachments; this.deps.attach(scope.id, attachments); }
    this.changed();
  }
  private async execute(scope: UploadScope, task: UploadTask, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const session = this.session;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (session) {
        // A manually reselected file must match before replacing the saved original.
        if (task.file && task.sha256 && !task.verified && !await this.verify(task, signal)) return;
        if (!this.records.has(task.id) || (task.file && !task.cached && !task.cacheWarning)) {
          const file = task.file && task.byteSize <= MAX_CACHED_UPLOAD_BYTES ? task.file : undefined;
          if (file) { task.status = "saving"; this.changed(); }
          const saved = await this.save(session, scope, task, file);
          signal.throwIfAborted();
          if (saved) {
            this.records.add(task.id); task.cached = Boolean(file) || task.cached;
            if (file) task.cacheWarning = false;
          }
        }
        task.status = "restoring"; this.changed();
        const claim = await session.claim(task.id);
        signal.throwIfAborted();
        if (claim.state === "missing") { this.drop(scope, task); return; }
        if (claim.state === "busy") {
          task.status = "waiting";
          this.wakeTimers.set(task, setTimeout(() => {
            this.wakeTimers.delete(task);
            if (this.current(scope, task)) { task.status = "queued"; this.changed(); this.pump(); }
          }, 5_000));
          return;
        }
        Object.assign(task, claim.record.task, { cached: claim.record.cached, status: "queued" });
        if (!task.file && claim.blob) task.file = new File([claim.blob], task.fileName, { type: task.mimeType });
        if (!task.file) task.cached = false;
        this.owners.set(task, session);
        heartbeat = setInterval(() => {
          void session.renew(task.id).then((valid) => {
            if (!valid && this.current(scope, task)) { this.drop(scope, task); controller.abort(); }
          }).catch(() => this.warnCache(task));
        }, 10_000);
      } else this.warnCache(task);
    } catch (error) {
      signal.throwIfAborted();
      // A browser quota or IndexedDB failure must not prevent the current File from uploading.
      this.warnCache(task);
      if (!task.file && !task.created) { task.status = "needs-file"; return; }
    }
    try {
      try { await this.run(scope, task, signal); }
      catch (error) {
        if ((error as { code?: string }).code !== "expired" || !task.file || signal.aborted) throw error;
        // Keep the local ID/lease stable while replacing an expired server receipt.
        task.remoteId = crypto.randomUUID(); task.created = false; task.offset = 0;
        this.changed();
        if (session && this.owners.has(task)) await this.save(session, scope, task);
        await this.run(scope, task, signal);
      }
    } finally {
      clearInterval(heartbeat);
      if (this.owners.get(task) === session && session) {
        if (this.current(scope, task)) {
          await this.save(session, scope, task).catch(() => this.warnCache(task));
          await session.release(task.id).catch(() => {});
        }
        this.owners.delete(task);
      }
    }
  }
  private async verify(task: UploadTask, signal: AbortSignal): Promise<boolean> {
    task.status = "hashing"; task.hashedBytes = 0; this.changed();
    const hash = await this.deps.hash(task.file!, signal, (bytes) => { if (!signal.aborted) { task.hashedBytes = bytes; this.progressed(); } });
    signal.throwIfAborted();
    if (task.file!.size !== task.byteSize || (task.sha256 && task.sha256 !== hash)) {
      task.file = undefined; task.status = "needs-file"; task.error = t("uploads.wrong_file"); return false;
    }
    task.sha256 = hash; task.verified = true;
    return true;
  }
  private async run(scope: UploadScope, task: UploadTask, signal: AbortSignal): Promise<void> {
    const accept = async (asset: FileAssetDto) => {
      if (!this.current(scope, task) || signal.aborted) return;
      const draftAttachments = draftAttachmentsForScope(scope.id);
      if (draftAttachments) scope.attachments = draftAttachments;
      if (asset.kind === "image") {
        const images = scope.attachments.filter((item) => item.kind === "image");
        const pending = scope.tasks.filter((item) => item !== task && item.image);
        const limit = this.deps.imageLimits().message;
        if (images.length + pending.length >= MAX_IMAGES_PER_MESSAGE || [...images, ...pending].reduce((sum, item) => sum + item.byteSize, 0) + asset.byteSize > limit) {
          throw new Error(t("AttachmentEditor.attach_up_to_4_images_per_message_with_a_total", { size: formatBytes(limit) }));
        }
      }
      scope.tasks = scope.tasks.filter((item) => item !== task);
      if (!scope.attachments.some((item) => item.id === asset.id)) scope.attachments = [...scope.attachments, asset];
      this.deps.attach(scope.id, scope.attachments); this.changed();
      await this.forget(this.session, task).catch(() => {});
    };
    let remote: FileUploadDto | undefined;
    if (task.created) {
      remote = await this.io(task, signal, () => this.deps.http.get(task.remoteId ?? task.id, signal));
      if (remote.state === "completed" && remote.asset) { await accept(remote.asset); return; }
      if (remote.state === "failed") {
        if (remote.error === "disk_full") remote = await this.io(task, signal, () => this.deps.http.complete(task.remoteId ?? task.id, signal));
        else throw new Error(t(errorI18n({ i18n: { key: `uploads.${remote.error}` } })?.key ?? "uploads.incomplete"));
      }
      if (remote.state === "completed" && remote.asset) { await accept(remote.asset); return; }
      task.offset = remote.offset;
    }
    if (remote?.state === "uploading" && remote.offset === task.byteSize) {
      remote = await this.io(task, signal, () => this.deps.http.complete(task.remoteId ?? task.id, signal));
      if (remote.state === "completed" && remote.asset) { await accept(remote.asset); return; }
      if (remote.state === "failed") throw new Error(t(errorI18n({ i18n: { key: `uploads.${remote.error}` } })?.key ?? "uploads.incomplete"));
    }
    if (remote?.state !== "checking") {
      if (!task.file) { task.status = "needs-file"; return; }
      if (!task.verified && !await this.verify(task, signal)) return;
      if (!task.created) {
        remote = await this.io(task, signal, () => this.deps.http.create({ id: task.remoteId ?? task.id, fileName: task.fileName, mimeType: task.mimeType, byteSize: task.byteSize, sha256: task.sha256!, kind: task.image ? "image" : "file" }, signal));
        task.created = true; this.changed();
      }
      if (remote?.state === "uploading") { task.status = "uploading"; this.changed(); }
      // The last response carries the acknowledged offset; only a failed request needs a fresh query.
      let stale = !remote;
      while (remote?.state === "uploading") {
        const known: FileUploadDto | undefined = remote;
        remote = await this.io(task, signal, async () => {
          const latest = stale || !known ? await this.deps.http.get(task.remoteId ?? task.id, signal) : known;
          stale = true;
          task.offset = latest.offset;
          if (latest.state !== "uploading" || latest.offset === task.byteSize) { stale = false; return latest; }
          let next: FileUploadDto;
          try { next = await this.deps.http.append(task.remoteId ?? task.id, latest.offset, task.file!.slice(latest.offset, latest.offset + FILE_UPLOAD_CHUNK_BYTES), signal); }
          catch (error) { if ((error as { status?: number }).status === 409) next = await this.deps.http.get(task.remoteId ?? task.id, signal); else throw error; }
          stale = false;
          return next;
        });
        task.offset = remote.offset; this.progressed();
        if (remote.offset === task.byteSize) break;
      }
      if (remote?.state === "uploading") remote = await this.io(task, signal, () => this.deps.http.complete(task.remoteId ?? task.id, signal));
    }
    for (let poll = 0; remote?.state === "checking"; poll++) {
      if (task.status !== "checking") { task.status = "checking"; this.changed(); }
      await this.deps.delay(CHECK_DELAYS_MS[Math.min(poll, CHECK_DELAYS_MS.length - 1)]!, signal);
      remote = await this.io(task, signal, () => this.deps.http.get(task.remoteId ?? task.id, signal));
    }
    signal.throwIfAborted();
    if (remote?.state === "completed" && remote.asset) await accept(remote.asset);
    else throw new Error(t(errorI18n({ i18n: { key: `uploads.${remote?.error}` } })?.key ?? "uploads.incomplete"));
  }
}

export const uploadStore = createStore({ revision: 0 });
let notifyFrame: number | undefined;
/** State changes notify at once: a send confirmed in the same frame must see reattached files. */
function notifyUploadsChanged(): void {
  if (notifyFrame !== undefined) { cancelAnimationFrame(notifyFrame); notifyFrame = undefined; }
  uploadStore.set((state) => ({ revision: state.revision + 1 }));
}
/** Hash and chunk progress can tick many times per frame; the composer re-renders at most once. */
function notifyUploadProgress(): void {
  if (typeof requestAnimationFrame !== "function" || document.visibilityState !== "visible") return notifyUploadsChanged();
  notifyFrame ??= requestAnimationFrame(() => { notifyFrame = undefined; uploadStore.set((state) => ({ revision: state.revision + 1 })); });
}
let imageLimitMiB: number | undefined;
/** Mirrors the server setting so oversized images are rejected before upload. */
export function setImageUploadLimit(mib: number | undefined): void { imageLimitMiB = mib; }
export const uploadManager = new FileUploadManager({
  http: fileUploadHttp, hash: hashFileInWorker,
  imageLimits: () => imageUploadLimits(imageLimitMiB),
  storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: (key) => sessionStorage.removeItem(key) },
  persistence: new FileUploadDatabase(),
  attach: updateDraftAttachments, changed: notifyUploadsChanged, progressed: notifyUploadProgress,
  delay: uploadDelay, online: () => navigator.onLine !== false
});
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => uploadManager.suspend());
  window.addEventListener("pageshow", () => uploadManager.resume());
}
