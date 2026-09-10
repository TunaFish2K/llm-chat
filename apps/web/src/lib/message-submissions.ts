import type { ConversationStartedDto, GenerationCreatedDto, MessageSubmissionDto } from "@llm-chat/contracts";
import { ApiRequestError, endpoints } from "./api";
import { appStore, loadMessages, refreshConversations, toastError, trackGeneration } from "./app-state";
import { createStore } from "./store";
import { readComposerDraft, writeComposerDraft, type ComposerDraft } from "./composer-drafts";
import { conversationDeleted, conversationSource } from "./conversation-lifecycle";
import { navigate, routes } from "./router";

type StartInput = Parameters<typeof endpoints.startConversation>[0];
export interface PendingSubmission {
  id: string;
  sourceId?: string | null;
  scope: string | null;
  kind: "start" | "send" | "queue";
  status: "preparing" | "sending" | "unknown" | "failed" | "accepted";
  draft: ComposerDraft;
  input?: StartInput;
  newChatScript?: boolean;
  text: string;
  mode: "queue" | "steer";
  receipt?: MessageSubmissionDto;
  error?: string;
}
const KEY = "llm-chat.submissions.v1";
export const submissionStore = createStore<{ items: PendingSubmission[] }>({ items: [] });
const active = new Map<string, Promise<void>>();
const preparing = new Set<string>();
let navigationVersion = 0;
let epoch = 0;
window.addEventListener("popstate", () => { navigationVersion++; });
function save(items: PendingSubmission[]) {
  submissionStore.set({ items });
  try { sessionStorage.setItem(KEY, JSON.stringify(items)); }
  catch { window.dispatchEvent(new Event("llm-chat:draft-storage-unavailable")); }
}
function update(id: string, patch: Partial<PendingSubmission>) {
  save(submissionStore.get().items.map((item) => item.id === id ? { ...item, ...patch } : item));
}
export function restoreSubmissions() {
  if (active.size) return;
  try {
    const items: PendingSubmission[] = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(items)) return;
    save(items.filter((item) => item && (item.sourceId ?? null) === conversationSource() && typeof item.id === "string" &&
      /^(start|send|queue)$/.test(item.kind) && /^(preparing|sending|unknown|failed|accepted)$/.test(item.status) &&
      (item.scope === null || typeof item.scope === "string") && item.draft && typeof item.draft.text === "string" &&
      Array.isArray(item.draft.attachments) && item.draft.attachments.every((asset) => asset && typeof asset.id === "string" && typeof asset.url === "string" && typeof asset.fileName === "string") &&
      typeof item.text === "string" && (!item.input || (typeof item.input.text === "string" && typeof item.input.agentId === "string")) &&
      (!item.scope || !conversationDeleted(item.scope))).map((item) => ({ ...item,
        status: ["preparing", "sending"].includes(item.status) && !preparing.has(item.id) ? "unknown" : item.status })));
  } catch { /* Invalid local state is not sent. */ }
}
export function beginSubmission(scope: string | null, draft: ComposerDraft, kind: PendingSubmission["kind"], mode: "queue" | "steer", newChatScript = false): PendingSubmission {
  const pending: PendingSubmission = { id: crypto.randomUUID(), sourceId: conversationSource(), scope, draft, kind, mode, text: draft.text, newChatScript, status: "preparing" };
  preparing.add(pending.id);
  save([...submissionStore.get().items, pending]);
  return pending;
}
export function failSubmission(id: string, error: unknown, uncertain = false) {
  preparing.delete(id);
  update(id, { status: uncertain ? "unknown" : "failed", error: error instanceof Error ? error.message : String(error) });
}
export function forgetSubmission(id: string) { preparing.delete(id); save(submissionStore.get().items.filter((item) => item.id !== id)); }
export function takeSubmissionDraft(id: string): ComposerDraft | undefined {
  const item = submissionStore.get().items.find((entry) => entry.id === id);
  if (!item) return;
  // Recovery is explicit. Existing input becomes a separate retained draft.
  const current = readComposerDraft(item.scope);
  if (current && (current.text || current.attachments.length)) writeComposerDraft(`recovered-${crypto.randomUUID()}`, current);
  writeComposerDraft(item.scope, item.draft);
  forgetSubmission(id);
  return item.draft;
}

async function hydrate(item: PendingSubmission, receipt: MessageSubmissionDto) {
  if (receipt.deleted) { failSubmission(item.id, new Error("此次提交的记录已删除")); return; }
  if (item.scope === null) {
    const conversation = await endpoints.conversation(receipt.conversationId);
    if (conversationDeleted(conversation.id)) return;
    appStore.set((state) => ({ conversations: [...state.conversations.filter((entry) => entry.id !== conversation.id), conversation] }));
  }
  if (receipt.queuedMessageId) {
    const state = await endpoints.queueState(receipt.conversationId);
    window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: { conversationId: receipt.conversationId, state } }));
  }
  await loadMessages(receipt.conversationId);
  if (receipt.generationId && receipt.assistantMessageId) trackGeneration(receipt.conversationId, receipt.assistantMessageId, receipt.generationId);
  window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: { conversationId: receipt.conversationId } }));
  forgetSubmission(item.id);
}

export function reconcileSubmission(id: string): Promise<void> {
  const item = submissionStore.get().items.find((entry) => entry.id === id);
  if (!item) return Promise.resolve();
  const startedEpoch = epoch;
  return endpoints.submission(id).then(async (receipt) => {
    if (epoch !== startedEpoch) return;
    update(id, { receipt, status: "accepted" });
    await hydrate(item, receipt);
  });
}

export function submitPending(id: string, input?: StartInput): Promise<void> {
  preparing.delete(id);
  const existing = active.get(id);
  if (existing) return existing;
  const item = submissionStore.get().items.find((entry) => entry.id === id);
  if (!item) return Promise.resolve();
  if (input) { item.input = input; item.text = input.text; }
  if (!item.input) return Promise.reject(new Error("发送准备尚未完成，请恢复内容后重新发送"));
  const route = location.pathname, nav = navigationVersion, startedEpoch = epoch;
  update(id, { input: item.input, text: item.text, status: "sending" });
  const work = (async () => {
    const assets = item.draft.attachments.map((asset) => asset.id);
    let generation: GenerationCreatedDto | undefined;
    let queuedMessageId: string | null = null;
    let conversationId = item.scope;
    try {
      if (item.kind === "start") {
        const result: ConversationStartedDto = await endpoints.startConversation({ ...item.input!, clientRequestId: id });
        if (startedEpoch !== epoch) return;
        conversationId = result.conversation.id;
        generation = result.generation;
        if (conversationDeleted(conversationId)) { forgetSubmission(id); return; }
        appStore.set((state) => ({ conversations: [...state.conversations.filter((entry) => entry.id !== conversationId), result.conversation] }));
        // Move only the draft owned by this navigation, never one edited on a later route.
        if (nav === navigationVersion && route === location.pathname) {
          const nextDraft = readComposerDraft(null);
          if (nextDraft) writeComposerDraft(conversationId, nextDraft);
          writeComposerDraft(null, { ...item.draft, text: "", attachments: [] });
          navigate(routes.chat(conversationId));
        }
      } else if (item.kind === "send") {
        try { generation = await endpoints.sendMessage(conversationId!, item.text, assets, id); }
        catch (error) {
          if (!(error instanceof ApiRequestError) || error.code !== "conversation_busy") throw error;
          item.kind = "queue"; update(id, { kind: "queue" });
        }
      }
      if (item.kind === "queue") {
        const queued = await endpoints.enqueueMessage(conversationId!, item.text, assets, item.mode, id);
        queuedMessageId = queued.id;
      }
      if (startedEpoch !== epoch) return;
      const receipt: MessageSubmissionDto = { clientRequestId: id, kind: item.kind, conversationId: conversationId!, deleted: false,
        queuedMessageId, userMessageId: generation?.userMessageId ?? null, assistantMessageId: generation?.assistantMessageId ?? null,
        generationId: generation?.generationId ?? null };
      update(id, { receipt, status: "accepted" });
      if (item.newChatScript && item.kind === "start") {
        update(id, { newChatScript: false }); item.newChatScript = false;
        void endpoints.executeRoleplayScript(receipt.conversationId, { trigger: "new_chat", draft: "" }).catch(toastError);
      }
      try { await hydrate({ ...item, scope: conversationId }, receipt); }
      catch { update(id, { error: "消息已接受，暂时无法刷新记录" }); }
      void refreshConversations().catch(() => undefined);
    } catch (error) {
      if (startedEpoch !== epoch) return;
      const uncertain = !(error instanceof ApiRequestError) || error.status === 0 || error.status >= 500 || error.code === "invalid_response";
      failSubmission(id, error, uncertain);
      toastError(error);
    }
  })().finally(() => { active.delete(id); });
  active.set(id, work);
  return work;
}

window.addEventListener("llm-chat:conversations-deleted", (event) => {
  const ids = (event as CustomEvent<{ ids: string[] }>).detail.ids;
  save(submissionStore.get().items.filter((item) => !ids.includes(item.receipt?.conversationId ?? item.scope ?? "")));
});
window.addEventListener("llm-chat:submissions-clear", () => { epoch++; preparing.clear(); save([]); });
