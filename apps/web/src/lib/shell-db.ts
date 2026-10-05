import type { ShellState } from "./app-shell";

// Separate from offline history: logging out or resetting history must never
// remove the files that start the application.
const EMPTY: ShellState = { current: null, previous: null, staged: null };
let database: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("llm-chat-shell", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("state"); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("App shell storage is blocked by another page"));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

export async function readShellState(): Promise<ShellState> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get("shell");
    request.onsuccess = () => resolve((request.result as ShellState | undefined) ?? { ...EMPTY });
    request.onerror = () => reject(request.error);
  });
}

/** Applies `change` atomically; throwing inside it aborts without writing. */
export async function updateShellState(change: (state: ShellState) => ShellState): Promise<ShellState> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    let next: ShellState;
    let failure: unknown;
    const request = store.get("shell");
    request.onsuccess = () => {
      try {
        next = change((request.result as ShellState | undefined) ?? { ...EMPTY });
        store.put(next, "shell");
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("App shell state could not be saved"));
  });
}
