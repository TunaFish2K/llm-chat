import { useCallback, useEffect, useRef, useSyncExternalStore, type SetStateAction } from "react";
import { displayError } from "./error-display";

interface Snapshot<T> { data: T | null; error: string | null; refreshing: boolean }
interface Entry<T> { snapshot: Snapshot<T>; listeners: Set<() => void>; touched: number; pending?: Promise<void>; revision: number }
const entries = new Map<string, Entry<unknown>>();
let epoch = 0;
function entryFor<T>(key: string): Entry<T> {
  for (const [id, entry] of entries) if (!entry.listeners.size && !entry.pending && Date.now() - entry.touched > 600_000) entries.delete(id);
  if (!entries.has(key)) {
    for (const [id, entry] of entries) {
      if (entries.size < 50) break;
      if (!entry.listeners.size && !entry.pending) entries.delete(id);
    }
    entries.set(key, { snapshot: { data: null, error: null, refreshing: false }, listeners: new Set(), touched: Date.now(), revision: 0 });
  }
  const entry = entries.get(key)! as Entry<T>;
  entry.touched = Date.now();
  return entry;
}
function publish<T>(entry: Entry<T>, patch: Partial<Snapshot<T>>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.touched = Date.now();
  for (const notify of entry.listeners) notify();
}
/** Fence all reads at authentication/source boundaries, including mounted readers. */
export function clearResources() {
  epoch++;
  invalidateResources(() => true);
}
export function invalidateResources(matches: (key: string) => boolean) {
  for (const [key, entry] of entries) {
    if (!matches(key)) continue;
    entry.revision++;
    delete entry.pending;
    publish(entry, { data: null, error: null, refreshing: false });
    if (!entry.listeners.size) entries.delete(key);
  }
}
export function useResource<T>(key: string | null, read: () => Promise<T>) {
  const entry = entryFor<T>(key ?? "disabled");
  const reader = useRef(read); reader.current = read;
  const subscribe = useCallback((notify: () => void) => { entry.listeners.add(notify); return () => { entry.listeners.delete(notify); }; }, [entry]);
  const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot);
  const reload = useCallback((): Promise<void> => {
    if (key === null) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const session = epoch, revision = ++entry.revision, action = reader.current;
    publish(entry, { refreshing: true, error: null });
    const pending = Promise.resolve().then(() => action()).then(data => {
      if (session === epoch && revision === entry.revision) publish(entry, { data });
    }, error => {
      if (session === epoch && revision === entry.revision) publish(entry, { error: displayError(error) });
    }).finally(() => {
      if (entry.pending !== pending) return;
      delete entry.pending;
      publish(entry, { refreshing: false });
    });
    entry.pending = pending;
    return pending;
  }, [entry, key]);
  const setData = useCallback((next: SetStateAction<T | null>) => {
    entry.revision++;
    publish(entry, { data: typeof next === "function" ? (next as (old: T | null) => T | null)(entry.snapshot.data) : next });
  }, [entry]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...snapshot, loading: snapshot.data === null && !snapshot.error, reload, setData };
}
