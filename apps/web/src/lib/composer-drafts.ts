import { conversationDeleted } from "./conversation-lifecycle";
import { endpoints } from "./api";
import { removeStoredComposerDraft } from "./composer-draft-storage";
export { readComposerDraft, writeComposerDraft, preserveDeletedDraft, recoveredDraftIds, swapRecoveredDraft, draftImageUrls, type ComposerDraft } from "./composer-draft-storage";

// Requests outlive the composer. A remount must share the same write ordering.
const writes = new Map<string, Promise<unknown>>();
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

function writeServerDraft(id: string, text: string): Promise<unknown> {
  const next = (writes.get(id) ?? Promise.resolve()).catch(() => undefined)
    .then(() => conversationDeleted(id) ? undefined : endpoints.updateConversation(id, { draft: text }));
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}

export function scheduleServerDraft(id: string, text: string): void {
  if (conversationDeleted(id)) return;
  const previous = pending.get(id);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => { void flushServerDraft(id).catch(() => undefined); }, 500);
  pending.set(id, { text, timer });
}

export async function flushServerDraft(id: string): Promise<void> {
  if (conversationDeleted(id)) return;
  const item = pending.get(id);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(id);
    await writeServerDraft(id, item.text);
  } else await writes.get(id);
}

const modelWrites = new Map<string, Promise<unknown>>();
export function serializeModelSelection<T>(agentId: string, select: () => Promise<T>): Promise<T> {
  const next = (modelWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined).then(select);
  modelWrites.set(agentId, next);
  void next.finally(() => { if (modelWrites.get(agentId) === next) modelWrites.delete(agentId); }).catch(() => undefined);
  return next;
}

export function removeComposerDraft(id: string): void {
  const item = pending.get(id);
  if (item) clearTimeout(item.timer);
  pending.delete(id);
  removeStoredComposerDraft(id);
}
