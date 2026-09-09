import { conversationExecutionOverridesSchema, type ConversationExecutionOverrides, type FileAssetDto } from "@llm-chat/contracts";
import { endpoints } from "./api";

export interface ComposerDraft {
  text: string;
  attachments: FileAssetDto[];
  agentId: string | null;
  overrides: ConversationExecutionOverrides;
  workspace: string | null;
  greetingIndex: number;
}

const prefix = "llm-chat.composer.v1.";
const fallback = new Map<string, ComposerDraft>();
let warned = false;
const keyFor = (id: string | null) => prefix + (id ?? "new");

export function readComposerDraft(id: string | null): ComposerDraft | null {
  const key = keyFor(id);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return fallback.get(key) ?? null;
    const value = JSON.parse(raw) as ComposerDraft;
    if (typeof value.text !== "string" || !Array.isArray(value.attachments) ||
      !(value.agentId === null || typeof value.agentId === "string") ||
      !(value.workspace === null || typeof value.workspace === "string") ||
      !Number.isInteger(value.greetingIndex) || value.greetingIndex < 0) return null;
    const overrides = conversationExecutionOverridesSchema.safeParse(value.overrides);
    if (!overrides.success) return null;
    const attachments = value.attachments.filter((asset) => asset && typeof asset.id === "string" &&
      typeof asset.url === "string" && typeof asset.fileName === "string" && typeof asset.mimeType === "string" &&
      typeof asset.byteSize === "number" && (asset.kind === "image" || asset.kind === "file")).slice(0, 8);
    return { ...value, attachments, overrides: overrides.data };
  } catch { return fallback.get(key) ?? null; }
}

export function writeComposerDraft(id: string | null, draft: ComposerDraft): void {
  const key = keyFor(id);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
    fallback.delete(key);
  } catch {
    fallback.set(key, draft);
    if (!warned) {
      warned = true;
      window.dispatchEvent(new Event("llm-chat:draft-storage-unavailable"));
    }
  }
}

// Requests outlive the composer. A remount must share the same write ordering.
const writes = new Map<string, Promise<unknown>>();
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

function writeServerDraft(id: string, text: string): Promise<unknown> {
  const next = (writes.get(id) ?? Promise.resolve()).catch(() => undefined)
    .then(() => endpoints.updateConversation(id, { draft: text }));
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}

export function scheduleServerDraft(id: string, text: string): void {
  const previous = pending.get(id);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => { void flushServerDraft(id).catch(() => undefined); }, 500);
  pending.set(id, { text, timer });
}

export async function flushServerDraft(id: string): Promise<void> {
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
