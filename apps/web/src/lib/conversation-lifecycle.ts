import { t } from "./i18n";
const KEY = "llm-chat.deleted-conversations.v1";
let sourceId: string | null = null;
let deleted = new Set<string>();
let revision = 0;
const requests = new Map<string, Set<AbortController>>();
export const localDeletions = new Set<string>();
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  if (saved && Array.isArray(saved.ids)) { sourceId = saved.sourceId; deleted = new Set(saved.ids.filter((id: unknown) => typeof id === "string")); }
} catch {}
export function deletionRevision(): number { return revision; }
let cachedStorage: string | null | undefined;
let cachedSource: string | null = null;
let cachedIds = new Set<string>();
function persistedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== cachedStorage) {
      cachedStorage = raw;
      cachedIds = new Set();
      cachedSource = null;
      const value = JSON.parse(raw ?? "null");
      if (value && Array.isArray(value.ids)) {
        cachedSource = value.sourceId;
        cachedIds = new Set(value.ids.filter((id: unknown) => typeof id === "string"));
      }
    }
  } catch { cachedIds = new Set(); }
  return cachedSource === sourceId ? cachedIds : new Set();
}
export function conversationDeleted(id: string): boolean {
  // A different tab can commit before its storage event reaches this tab.
  return deleted.has(id) || persistedIds().has(id);
}
export function deletedConversationIds(): string[] { return [...new Set([...deleted, ...persistedIds()])]; }
function persist(): void {
  try {
    const previous = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const ids = new Set(deleted);
    if (previous?.sourceId === sourceId && Array.isArray(previous.ids)) for (const id of previous.ids) if (typeof id === "string") ids.add(id);
    localStorage.setItem(KEY, JSON.stringify({ sourceId, ids: [...ids] }));
  } catch {}
}
export function setConversationSource(id: string): void {
  if (sourceId && sourceId !== id) { deleted.clear(); revision++; }
  sourceId = id; persist();
}
export function markConversationsDeleted(ids: string[], local = false): void {
  const fresh = ids.filter((id) => !deleted.has(id));
  if (!fresh.length) return;
  for (const id of fresh) {
    deleted.add(id);
    for (const controller of requests.get(id) ?? []) controller.abort();
    requests.delete(id);
  }
  revision++; persist();
  window.dispatchEvent(new CustomEvent("llm-chat:conversations-deleted", { detail: { ids: fresh, local: local || ids.some((id) => localDeletions.has(id)) } }));
}
export function trackConversationRequest(id: string, controller: AbortController): () => void {
  const pending = requests.get(id) ?? new Set<AbortController>();
  pending.add(controller); requests.set(id, pending);
  return () => { pending.delete(controller); if (!pending.size) requests.delete(id); };
}
export class DeletedConversationError extends Error {
  readonly code = "conversation_deleted_local";
  readonly status = 404;
  constructor() { super(t("WorkspaceSidebar.conversation_deleted")); }
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== KEY || !event.newValue) return;
  try {
    const value = JSON.parse(event.newValue);
    if (value.sourceId !== sourceId || !Array.isArray(value.ids)) return;
    markConversationsDeleted(value.ids);
  } catch {}
});
