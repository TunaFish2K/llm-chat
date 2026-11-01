import type { FileAssetDto } from "@llm-chat/contracts";
import type { UploadScope, UploadTask } from "./file-upload-manager";

export const MAX_CACHED_UPLOAD_BYTES = 64 * 1024 ** 2;
export const UPLOAD_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
export const UPLOAD_LEASE_MS = 30_000;
export type StoredUploadTask = Omit<UploadTask, "file" | "controller" | "verified" | "cached" | "cacheWarning">;
export interface StoredUpload {
  sourceId: string;
  id: string;
  scopeId: string;
  conversationId?: string | undefined;
  attachments: FileAssetDto[];
  task: StoredUploadTask;
  savedAt: number;
  cached: boolean;
  owner: string | null;
  leaseUntil: number;
  removed?: boolean;
}
export type UploadClaim = { state: "claimed"; record: StoredUpload; blob?: Blob | undefined } | { state: "busy" } | { state: "missing" };
export interface UploadSession {
  list(): Promise<StoredUpload[]>;
  put(scope: UploadScope, task: StoredUploadTask, file?: Blob): Promise<boolean>;
  claim(id: string): Promise<UploadClaim>;
  renew(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}
export interface UploadPersistence { open(sourceId: string): Promise<UploadSession> }

/** Queue metadata and binary payloads are separate: status updates never copy a 64 MiB Blob. */
export class FileUploadDatabase implements UploadPersistence {
  private database: Promise<IDBDatabase> | undefined;
  constructor(private readonly name = "llm-chat-uploads", private readonly now = Date.now) {}
  private db(): Promise<IDBDatabase> {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("control");
        request.result.createObjectStore("tasks", { keyPath: ["sourceId", "id"] }).createIndex("source", "sourceId");
        request.result.createObjectStore("files");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Upload storage is blocked"));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
    }).catch((error) => { this.database = undefined; throw error; });
  }
  async open(sourceId: string): Promise<UploadSession> {
    const db = await this.db();
    const epoch = await new Promise<string>((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      const store = tx.objectStore("control");
      const request = store.get(sourceId);
      let value: string;
      request.onsuccess = () => { value = request.result ?? crypto.randomUUID(); store.put(value, sourceId); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    const owner = crypto.randomUUID();
    // A document lock disappears on reload/close even when its final IndexedDB writes are discarded.
    const lockName = (id: string) => `llm-chat-upload-owner:${this.name}:${id}`;
    const locks = globalThis.navigator?.locks;
    let releaseLock: (() => void) | undefined;
    let tracksOwners = false;
    if (locks) {
      await new Promise<void>((resolve) => {
        void locks.request(lockName(owner), async () => {
          tracksOwners = true;
          resolve();
          await new Promise<void>((release) => { releaseLock = release; });
        }).catch(() => resolve());
      });
    }
    const key = (id: string) => [sourceId, id];
    const access = <T>(fallback: T, action: (tx: IDBTransaction, finish: (value: T) => void) => void): Promise<T> => new Promise((resolve, reject) => {
      const tx = db.transaction(["control", "tasks", "files"], "readwrite");
      let value = fallback;
      const request = tx.objectStore("control").get(sourceId);
      request.onsuccess = () => { if (request.result === epoch) action(tx, (next) => { value = next; }); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    const available = (row: StoredUpload) => !row.removed && this.now() - row.savedAt <= UPLOAD_CACHE_TTL;
    const owned = (row: StoredUpload) => row.owner === owner;
    return {
      list: () => access<StoredUpload[]>([], (tx, finish) => {
        const tasks = tx.objectStore("tasks");
        const request = tasks.index("source").getAll(sourceId);
        request.onsuccess = () => {
          const rows = request.result as StoredUpload[];
          for (const row of rows) if (this.now() - row.savedAt > UPLOAD_CACHE_TTL) {
            tasks.delete(key(row.id)); tx.objectStore("files").delete(key(row.id));
          }
          finish(rows.filter(available));
        };
      }),
      put: async (scope, task, file) => {
        // WebKit can reject Blob/File values in private contexts; raw bytes remain persistable.
        const bytes = file && file.size <= MAX_CACHED_UPLOAD_BYTES ? await file.arrayBuffer() : undefined;
        return access(false, (tx, finish) => {
          const tasks = tx.objectStore("tasks");
          const request = tasks.get(key(task.id));
          request.onsuccess = () => {
            const old = request.result as StoredUpload | undefined;
            // Tombstones stop a late save in another tab from resurrecting a cancelled task.
            if (old?.removed || (old?.owner && !owned(old) && old.leaseUntil > this.now())) return;
            const cached = file ? file.size <= MAX_CACHED_UPLOAD_BYTES : old?.cached ?? false;
            if (bytes) tx.objectStore("files").put(bytes, key(task.id));
            tasks.put({ sourceId, id: task.id, scopeId: scope.id, conversationId: scope.conversationId,
              attachments: scope.attachments, task, savedAt: this.now(), cached,
              owner: old?.owner ?? null, leaseUntil: old?.leaseUntil ?? 0 } satisfies StoredUpload);
            finish(true);
          };
        });
      },
      claim: async (id) => {
        let departedOwner: string | undefined;
        if (tracksOwners) {
          const previousOwner = await access<string | undefined>(undefined, (tx, finish) => {
            const request = tx.objectStore("tasks").get(key(id));
            request.onsuccess = () => finish((request.result as StoredUpload | undefined)?.owner ?? undefined);
          });
          if (previousOwner && previousOwner !== owner) {
            try {
              const snapshot = await locks!.query();
              if (!snapshot.held?.some((lock) => lock.name === lockName(previousOwner))) departedOwner = previousOwner;
            } catch { /* Keep the timed lease when document locks cannot be inspected. */ }
          }
        }
        return access<UploadClaim>({ state: "missing" }, (tx, finish) => {
          const tasks = tx.objectStore("tasks");
          const request = tasks.get(key(id));
          request.onsuccess = () => {
            const row = request.result as StoredUpload | undefined;
            if (!row || !available(row)) return;
            // Compare the observed owner again inside the transaction: another tab may have claimed it.
            if (row.owner && !owned(row) && row.owner !== departedOwner && row.leaseUntil > this.now()) { finish({ state: "busy" }); return; }
            row.owner = owner; row.leaseUntil = this.now() + UPLOAD_LEASE_MS;
            tasks.put(row);
            const bytes = tx.objectStore("files").get(key(id));
            bytes.onsuccess = () => {
              const stored = bytes.result as Blob | ArrayBuffer | undefined;
              const blob = stored && "byteLength" in stored ? new Blob([stored], { type: row.task.mimeType }) : stored;
              if (row.cached && (!blob || blob.size !== row.task.byteSize)) {
                row.cached = false; tasks.put(row); tx.objectStore("files").delete(key(id));
                finish({ state: "claimed", record: row });
              } else finish({ state: "claimed", record: row, blob });
            };
          };
        });
      },
      renew: (id) => access(false, (tx, finish) => {
        const tasks = tx.objectStore("tasks");
        const request = tasks.get(key(id));
        request.onsuccess = () => {
          const row = request.result as StoredUpload | undefined;
          if (!row || !available(row) || !owned(row)) return;
          row.leaseUntil = this.now() + UPLOAD_LEASE_MS; tasks.put(row); finish(true);
        };
      }),
      release: (id) => access(undefined, (tx) => {
        const tasks = tx.objectStore("tasks");
        const request = tasks.get(key(id));
        request.onsuccess = () => {
          const row = request.result as StoredUpload | undefined;
          if (row && owned(row)) { row.owner = null; row.leaseUntil = 0; tasks.put(row); }
        };
      }),
      remove: (id) => access(undefined, (tx) => {
        const tasks = tx.objectStore("tasks");
        const request = tasks.get(key(id));
        request.onsuccess = () => {
          const row = request.result as StoredUpload | undefined;
          if (row) tasks.put({ ...row, removed: true, cached: false, owner: null, leaseUntil: 0, savedAt: this.now() });
          tx.objectStore("files").delete(key(id));
        };
      }),
      clear: () => access(undefined, (tx) => {
        releaseLock?.();
        tx.objectStore("control").put(crypto.randomUUID(), sourceId);
        const tasks = tx.objectStore("tasks");
        const request = tasks.index("source").getAllKeys(sourceId);
        request.onsuccess = () => { for (const entry of request.result) { tasks.delete(entry); tx.objectStore("files").delete(entry); } };
      })
    };
  }
}
