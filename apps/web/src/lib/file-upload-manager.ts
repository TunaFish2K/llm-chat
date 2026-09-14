import { errorI18n } from "@llm-chat/i18n";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, type FileAssetDto, type FileUploadDto } from "@llm-chat/contracts";
import { fileUploadHttp, type FileUploadHttp } from "./file-upload-http";
import { hashFileInWorker } from "./file-hash-client";
import { endpoints } from "./api";
import { fileToBase64 } from "./format";
import { createStore } from "./store";
import { updateDraftAttachments } from "./composer-draft-storage";
import { t } from "./i18n";

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
  image: (file: File) => Promise<FileAssetDto>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  changed: () => void;
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
  enqueue(id: string, files: File[]): string[] {
    if (!this.enabled) return [t("error.authentication_required")];
    const scope = this.scopes.get(id)!;
    const errors: string[] = [];
    for (const file of files) {
      const pending = scope.tasks.map((task) => ({ byteSize: task.byteSize, kind: task.image ? "image" : "file" }));
      const all = [...scope.attachments, ...pending];
      const image = IMAGE_TYPES.has(file.type);
      if (all.length >= 8) { errors.push(t("AttachmentEditor.attach_up_to_8_files_per_message")); break; }
      if (!file.size || file.size > (image ? 5 * 1024 ** 2 : MAX_ATTACHMENT_FILE_BYTES)) { errors.push(t(image ? "uploads.image_limit" : "uploads.file_limit")); continue; }
      const images = all.filter((asset) => asset.kind === "image");
      if (image && (images.length >= 4 || images.reduce((sum, asset) => sum + asset.byteSize, 0) + file.size > 15 * 1024 ** 2)) {
        errors.push(t("AttachmentEditor.attach_up_to_4_images_per_message_with_a_total")); continue;
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
    for (let attempt = 0; ; attempt++) {
      while (!this.deps.online()) { task.status = "waiting"; this.changed(); await this.deps.delay(1000, signal); }
      signal.throwIfAborted();
      try { return await action(); }
      catch (error) {
        signal.throwIfAborted();
        const status = (error as { status?: number }).status;
        if (attempt >= 3 || !(status === 0 || status === 408 || status === 429 || (status !== undefined && status >= 500 && status !== 507))) throw error;
        task.status = "waiting"; this.changed();
        await this.deps.delay(1000 * 2 ** attempt, signal);
      }
    }
  }
  private async run(scope: UploadScope, task: UploadTask, signal: AbortSignal): Promise<void> {
    const accept = (asset: FileAssetDto) => {
      if (!this.current(scope, task) || signal.aborted) return;
      if (asset.kind === "image") {
        const images = scope.attachments.filter((item) => item.kind === "image");
        const pending = scope.tasks.filter((item) => item !== task && item.image);
        if (images.length + pending.length >= 4 || [...images, ...pending].reduce((sum, item) => sum + item.byteSize, 0) + asset.byteSize > 15 * 1024 ** 2) {
          throw new Error(t("AttachmentEditor.attach_up_to_4_images_per_message_with_a_total"));
        }
      }
      scope.tasks = scope.tasks.filter((item) => item !== task);
      if (!scope.attachments.some((item) => item.id === asset.id)) scope.attachments = [...scope.attachments, asset];
      this.deps.attach(scope.id, scope.attachments); this.changed();
    };
    if (task.image) {
      if (!task.file) { task.status = "needs-file"; return; }
      task.status = "uploading"; this.changed();
      accept({ ...await this.deps.image(task.file), kind: "image" }); return;
    }
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
        const hash = await this.deps.hash(task.file, signal, (bytes) => { if (!signal.aborted) { task.hashedBytes = bytes; this.changed(); } });
        signal.throwIfAborted();
        if (task.file.size !== task.byteSize || (task.sha256 && task.sha256 !== hash)) {
          task.file = undefined; task.status = "needs-file"; task.error = t("uploads.wrong_file"); return;
        }
        task.sha256 = hash; task.verified = true;
      }
      if (!task.created) {
        remote = await this.io(task, signal, () => this.deps.http.create({ id: task.id, fileName: task.fileName, mimeType: task.mimeType, byteSize: task.byteSize, sha256: task.sha256! }, signal));
        task.created = true; this.changed();
      }
      while (remote?.state === "uploading") {
        remote = await this.io(task, signal, async () => {
          const latest = await this.deps.http.get(task.id, signal);
          task.offset = latest.offset; task.status = "uploading"; this.changed();
          if (latest.state !== "uploading" || latest.offset === task.byteSize) return latest;
          try { return await this.deps.http.append(task.id, latest.offset, task.file!.slice(latest.offset, latest.offset + FILE_UPLOAD_CHUNK_BYTES), signal); }
          catch (error) { if ((error as { status?: number }).status === 409) return this.deps.http.get(task.id, signal); throw error; }
        });
        task.offset = remote.offset; this.changed();
        if (remote.offset === task.byteSize) break;
      }
      if (remote?.state === "uploading") remote = await this.io(task, signal, () => this.deps.http.complete(task.id, signal));
    }
    while (remote?.state === "checking") {
      task.status = "checking"; this.changed();
      await this.deps.delay(500, signal);
      remote = await this.io(task, signal, () => this.deps.http.get(task.id, signal));
    }
    signal.throwIfAborted();
    if (remote?.state === "completed" && remote.asset) accept(remote.asset);
    else throw new Error(t(errorI18n({ i18n: { key: `uploads.${remote?.error}` } })?.key ?? "uploads.incomplete"));
  }
}

export const uploadStore = createStore({ revision: 0 });
export const uploadManager = new FileUploadManager({
  http: fileUploadHttp, hash: hashFileInWorker,
  image: async (file) => endpoints.uploadImage(file.name || "pasted-image.png", await fileToBase64(file)),
  storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: (key) => sessionStorage.removeItem(key) },
  attach: updateDraftAttachments, changed: () => uploadStore.set((state) => ({ revision: state.revision + 1 })),
  delay: uploadDelay, online: () => navigator.onLine !== false
});
