import type { OfflineConversationDto, OfflineManifestDto } from "@llm-chat/contracts";

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
export async function offlineConversations(): Promise<OfflineConversationDto[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("conversations").objectStore("conversations").getAll();
    request.onsuccess = () => resolve(request.result as OfflineConversationDto[]);
    request.onerror = () => reject(request.error);
  });
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
