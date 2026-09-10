import { conversationExecutionOverridesSchema, type ConversationExecutionOverrides, type FileAssetDto } from "@llm-chat/contracts";
import { conversationDeleted } from "./conversation-lifecycle";

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
  if (id && conversationDeleted(id)) return;
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

export function preserveDeletedDraft(id: string): void {
  const draft = readComposerDraft(id);
  if (!draft || (!draft.text && !draft.attachments.length)) return;
  const existing = readComposerDraft(null);
  if (existing && (existing.text || existing.attachments.length)) {
    // Each collision gets its own slot; successive deletions never overwrite an older draft.
    writeComposerDraft("recovered-" + crypto.randomUUID(), existing);
  }
  writeComposerDraft(null, draft);
}
export function recoveredDraftIds(): string[] {
  const keys = new Set(fallback.keys());
  try { for (let i = 0; i < sessionStorage.length; i++) keys.add(sessionStorage.key(i)!); } catch {}
  return [...keys].filter((key) => key.startsWith(prefix + "recovered-")).map((key) => key.slice(prefix.length));
}
export function swapRecoveredDraft(): ComposerDraft | null {
  const id = recoveredDraftIds()[0];
  if (!id) return null;
  const draft = readComposerDraft(id);
  if (!draft) return null;
  const current = readComposerDraft(null);
  removeStoredComposerDraft(id);
  if (current && (current.text || current.attachments.length)) writeComposerDraft("recovered-" + crypto.randomUUID(), current);
  writeComposerDraft(null, draft);
  return draft;
}
export function draftImageUrls(): string[] {
  const keys = new Set(fallback.keys());
  try { for (let i = 0; i < sessionStorage.length; i++) keys.add(sessionStorage.key(i)!); } catch {}
  return [...keys].filter((key) => key.startsWith(prefix)).flatMap((key) =>
    readComposerDraft(key.slice(prefix.length) === "new" ? null : key.slice(prefix.length))?.attachments
      .filter((asset) => asset.kind === "image").map((asset) => asset.url) ?? []);
}
export function removeStoredComposerDraft(id: string): void {
  fallback.delete(keyFor(id));
  try { sessionStorage.removeItem(keyFor(id)); } catch {}
}

