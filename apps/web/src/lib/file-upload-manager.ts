import { errorI18n } from "@llm-chat/i18n";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_ATTACHMENT_BYTES, imageUploadLimits, type FileAssetDto, type FileUploadDto } from "@llm-chat/contracts";
import { fileUploadHttp, type FileUploadHttp } from "./file-upload-http";
import { hashFileInWorker } from "./file-hash-client";
import { formatBytes } from "./format";
import { createStore } from "./store";
import { updateDraftAttachments } from "./composer-draft-storage";
import { t } from "./i18n";
import { requestRetries } from "./request-preferences";
import { retryable, retryDelay } from "./request-retry";

export type UploadStatus = "queued" | "hashing" | "uploading" | "checking" | "waiting" | "needs-file" | "failed";
export interface UploadTask {
  id: string; fileName: string; mimeType: string; byteSize: number; image: boolean;
  sha256?: string; created: boolean; offset: number; hashedBytes: number;
  status: UploadStatus; error: string | null;
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
}
export class FileUploadManager {
  private scopes = new Map<string, UploadScope>();
  private sourceId = "local";
  private active = 0;
  private enabled = true;
  constructor(private readonly deps: Dependencies) {
    try {
      const saved = JSON.parse(deps.storage.getItem(KEY) ?? "null");
      if (saved && typeof saved.sourceId === "string" && Array.isArray(saved.scopes)) {
        this.sourceId = saved.sourceId;
        for (const scope of saved.scopes as UploadScope[]) {
          if (typeof scope.id !== "string" || !Array.isArray(scope.tasks) || !Array.isArray(scope.attachments)) continue;
          scope.tasks = scope.tasks.filter((task) => typeof task.id === "string" && typeof task.fileName === "string" && task.byteSize > 0 && task.byteSize <= MAX_ATTACHMENT_FILE_BYTES)
            .slice(0, 8).map((task) => ({ ...task, file: undefined, controller: undefined, verified: false, status: "needs-file" }));
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
    if (this.sourceId !== id) { this.reset(); this.sourceId = id; }
    this.enabled = true;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) {
      if (task.created && task.status === "needs-file") task.status = "queued";
    }
    this.changed(); this.pump();
  }
  /** Progress ticks only repaint; the stored queue changes on status transitions. */
  private progressed(): void { (this.deps.progressed ?? this.deps.changed)(); }
  private changed(): void {
    try {
      this.deps.storage.setItem(KEY, JSON.stringify({ sourceId: this.sourceId, scopes: this.all().map((scope) => ({
        ...scope, tasks: scope.tasks.map(({ file: _file, controller: _controller, verified: _verified, ...task }) => task)
      })) }));
    } catch { if (typeof window !== "undefined") window.dispatchEvent(new Event("llm-chat:draft-storage-unavailable")); }
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
      scope.tasks.push({ id: crypto.randomUUID(), fileName: file.name || "file", mimeType: file.type || "application/octet-stream", byteSize: file.size,
        image, created: false, offset: 0, hashedBytes: 0, file, status: "queued", error: null });
    }
    this.changed(); this.pump(); return errors;
  }
  retry(id: string, taskId: string, file?: File): void {
    const task = this.scopes.get(id)?.tasks.find((item) => item.id === taskId);
    if (!task || task.controller) return;
    if (file) { task.file = file; task.verified = false; }
    task.error = null; task.status = "queued";
    this.changed(); this.pump();
  }
  cancel(id: string, taskId: string): void {
    const scope = this.scopes.get(id);
    const task = scope?.tasks.find((item) => item.id === taskId);
    if (!scope || !task) return;
    task.controller?.abort();
    scope.tasks = scope.tasks.filter((item) => item !== task);
    // The create response might have been lost; deletion is idempotent even without created=true.
    if (task.sha256) void this.deps.http.cancel(task.id, AbortSignal.timeout(15_000)).catch(() => {});
    this.changed();
  }
  removeConversation(conversationId: string): void {
    for (const scope of this.scopes.values()) if (scope.conversationId === conversationId) {
      for (const task of [...scope.tasks]) this.cancel(scope.id, task.id);
      this.scopes.delete(scope.id);
    }
    this.changed();
  }
  reset(): void {
    this.enabled = false;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) task.controller?.abort();
    this.scopes.clear();
    try { this.deps.storage.removeItem(KEY); } catch {}
    this.deps.changed();
  }
  private current(scope: UploadScope, task: UploadTask) { return this.scopes.get(scope.id) === scope && scope.tasks.includes(task); }
  private pump(): void {
    if (!this.enabled) return;
    for (const scope of this.scopes.values()) for (const task of scope.tasks) {
      if (this.active >= 2) return;
      if (task.status !== "queued" || task.controller) continue;
      this.active++;
      const controller = new AbortController(); task.controller = controller;
      void this.run(scope, task, controller.signal).catch((error) => {
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
  private async run(scope: UploadScope, task: UploadTask, signal: AbortSignal): Promise<void> {
    const accept = (asset: FileAssetDto) => {
      if (!this.current(scope, task) || signal.aborted) return;
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
    };
    let remote: FileUploadDto | undefined;
    if (task.created) {
      remote = await this.io(task, signal, () => this.deps.http.get(task.id, signal));
      if (remote.state === "completed" && remote.asset) { accept(remote.asset); return; }
      if (remote.state === "failed") {
        if (remote.error === "disk_full") remote = await this.io(task, signal, () => this.deps.http.complete(task.id, signal));
        else throw new Error(t(errorI18n({ i18n: { key: `uploads.${remote.error}` } })?.key ?? "uploads.incomplete"));
      }
      if (remote.state === "completed" && remote.asset) { accept(remote.asset); return; }
      task.offset = remote.offset;
    }
    if (remote?.state !== "checking") {
      if (!task.file) { task.status = "needs-file"; return; }
      if (!task.verified) {
        task.status = "hashing"; task.hashedBytes = 0; this.changed();
        const hash = await this.deps.hash(task.file, signal, (bytes) => { if (!signal.aborted) { task.hashedBytes = bytes; this.progressed(); } });
        signal.throwIfAborted();
        if (task.file.size !== task.byteSize || (task.sha256 && task.sha256 !== hash)) {
          task.file = undefined; task.status = "needs-file"; task.error = t("uploads.wrong_file"); return;
        }
        task.sha256 = hash; task.verified = true;
      }
      if (!task.created) {
        remote = await this.io(task, signal, () => this.deps.http.create({ id: task.id, fileName: task.fileName, mimeType: task.mimeType, byteSize: task.byteSize, sha256: task.sha256!, kind: task.image ? "image" : "file" }, signal));
        task.created = true; this.changed();
      }
      if (remote?.state === "uploading") { task.status = "uploading"; this.changed(); }
      // The last response carries the acknowledged offset; only a failed request needs a fresh query.
      let stale = !remote;
      while (remote?.state === "uploading") {
        const known: FileUploadDto | undefined = remote;
        remote = await this.io(task, signal, async () => {
          const latest = stale || !known ? await this.deps.http.get(task.id, signal) : known;
          stale = true;
          task.offset = latest.offset;
          if (latest.state !== "uploading" || latest.offset === task.byteSize) { stale = false; return latest; }
          let next: FileUploadDto;
          try { next = await this.deps.http.append(task.id, latest.offset, task.file!.slice(latest.offset, latest.offset + FILE_UPLOAD_CHUNK_BYTES), signal); }
          catch (error) { if ((error as { status?: number }).status === 409) next = await this.deps.http.get(task.id, signal); else throw error; }
          stale = false;
          return next;
        });
        task.offset = remote.offset; this.progressed();
        if (remote.offset === task.byteSize) break;
      }
      if (remote?.state === "uploading") remote = await this.io(task, signal, () => this.deps.http.complete(task.id, signal));
    }
    for (let poll = 0; remote?.state === "checking"; poll++) {
      if (task.status !== "checking") { task.status = "checking"; this.changed(); }
      await this.deps.delay(CHECK_DELAYS_MS[Math.min(poll, CHECK_DELAYS_MS.length - 1)]!, signal);
      remote = await this.io(task, signal, () => this.deps.http.get(task.id, signal));
    }
    signal.throwIfAborted();
    if (remote?.state === "completed" && remote.asset) accept(remote.asset);
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
  attach: updateDraftAttachments, changed: notifyUploadsChanged, progressed: notifyUploadProgress,
  delay: uploadDelay, online: () => navigator.onLine !== false
});
