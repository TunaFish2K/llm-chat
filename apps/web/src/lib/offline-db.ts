import type { OfflineConversationDto, OfflineManifestDto } from "@llm-chat/contracts";
import { historyImageUrls } from "./offline-assets";

export const OFFLINE_IMAGES_PREFIX = "llm-chat-history-images-";
export interface OfflineControl { epoch: string; enabled: boolean; authorized: boolean; sourceId: string | null }
let database: Promise<IDBDatabase> | undefined;
export function openOfflineDb(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("llm-chat-history", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta");
      request.result.createObjectStore("conversations", { keyPath: "conversation.id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
  }).catch((error) => { database = undefined; throw error; });
  return database;
}
export async function offlineRead<T>(store: "meta" | "conversations", key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
/** A fresh transaction per item permits async processing without keeping the
 * entire history alive or relying on an IndexedDB transaction across awaits. */
export async function* iterateOfflineConversations(): AsyncGenerator<OfflineConversationDto> {
  const db = await openOfflineDb();
  let after: IDBValidKey | undefined;
  while (true) {
    const item = await new Promise<{ key: IDBValidKey; value: OfflineConversationDto } | undefined>((resolve, reject) => {
      const request = db.transaction("conversations").objectStore("conversations")
        .openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
      request.onsuccess = () => resolve(request.result ? { key: request.result.key, value: request.result.value as OfflineConversationDto } : undefined);
      request.onerror = () => reject(request.error);
    });
    if (!item) return;
    after = item.key;
    yield item.value;
  }
}

export interface OfflineConversationIndex {
  id: string; sourceId: string; revision: number; bytes: number; images: string[];
}
function conversationIndex(snapshot: OfflineConversationDto): OfflineConversationIndex {
  return { id: snapshot.conversation.id, sourceId: snapshot.sourceId, revision: snapshot.revision,
    bytes: new Blob([JSON.stringify(snapshot)]).size, images: historyImageUrls(snapshot.messages) };
}
export function putOfflineConversation(tx: IDBTransaction, snapshot: OfflineConversationDto): void {
  tx.objectStore("conversations").put(snapshot);
  tx.objectStore("meta").put(conversationIndex(snapshot), `conversation:${snapshot.conversation.id}`);
}
export function deleteOfflineConversation(tx: IDBTransaction, id: string): void {
  tx.objectStore("conversations").delete(id);
  tx.objectStore("meta").delete(`conversation:${id}`);
}

/** Old records gain metadata lazily; only one full snapshot is held at a time. */
export async function offlineConversationIndex(signal?: AbortSignal): Promise<OfflineConversationIndex[]> {
  const control = await offlineRead<OfflineControl>("meta", "control");
  const result: OfflineConversationIndex[] = [];
  for await (const snapshot of iterateOfflineConversations()) {
    signal?.throwIfAborted();
    let index = await offlineRead<OfflineConversationIndex>("meta", `conversation:${snapshot.conversation.id}`);
    if (!index || index.sourceId !== snapshot.sourceId || index.revision !== snapshot.revision || index.revision === -1) {
      index = conversationIndex(snapshot);
      if (control) await offlineWrite(control.epoch, (tx) => {
        // Do not let a migration racing a newer write overwrite its metadata.
        const current = tx.objectStore("conversations").get(index!.id);
        current.onsuccess = () => {
          const value = current.result as OfflineConversationDto | undefined;
          if (value?.sourceId === snapshot.sourceId && value.revision === snapshot.revision && snapshot.revision !== -1) {
            tx.objectStore("meta").put(index, `conversation:${index!.id}`);
          }
        };
      });
    }
    result.push(index);
  }
  return result;
}
export async function resetOfflineDb(control: OfflineControl): Promise<void> {
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["meta", "conversations"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("conversations").clear();
    tx.objectStore("meta").put(control, "control");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
/** The epoch check and writes share a transaction, fencing downloads after clear/logout. */
export async function offlineWrite(epoch: string, write: (tx: IDBTransaction) => void): Promise<boolean> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "conversations"], "readwrite");
    let applied = false;
    const request = tx.objectStore("meta").get("control");
    request.onsuccess = () => {
      const control = request.result as OfflineControl | undefined;
      if (control?.epoch === epoch && control.enabled && control.authorized) {
        try { write(tx); applied = true; } catch (error) { tx.abort(); reject(error); }
      }
    };
    tx.oncomplete = () => resolve(applied); tx.onabort = () => reject(tx.error);
  });
}
export async function readOfflineManifest(): Promise<OfflineManifestDto | undefined> {
  const control = await offlineRead<OfflineControl>("meta", "control");
  return control?.enabled && control.authorized ? offlineRead<OfflineManifestDto>("meta", "manifest") : undefined;
}
