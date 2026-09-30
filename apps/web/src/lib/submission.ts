/** Manual retries keep an immutable request, including across a page reload. */
import type { SubmissionAcceptedDto } from "@llm-chat/contracts";
import { createStore } from "./store";

export interface Submission {
  id: string;
  kind: "start" | "send" | "queue";
  text: string;
  assetIds: string[];
  attachments?: import("@llm-chat/contracts").FileAssetDto[];
  mode: "queue" | "steer";
  input: { agentId: string; greetingIndex: number; executionOverrides: import("@llm-chat/contracts").ConversationExecutionOverrides; workspacePath: string | null };
  originalText: string;
  prepared: boolean;
  status?: "preparing" | "submitting" | "unknown";
  route?: string;
}
export const submissionStore = createStore<{ pending: Record<string, Submission>; accepted: Record<string, SubmissionAcceptedDto> }>({ pending: {}, accepted: {} });
const memory = new Map<string, Submission>();
const sourceKey = "llm-chat.submission-source.v1";
let source: string | null = null;
const key = (conversationId: string | null) => `llm-chat.submission.v1.${conversationId ?? "new"}`;
export function setSubmissionSource(id: string) {
  try { source = sessionStorage.getItem(sourceKey) ?? source; } catch {}
  if (source && source !== id) clearSubmissions();
  source = id;
  try { sessionStorage.setItem(sourceKey, id); } catch {}
}
export function clearSubmissions() {
  memory.clear();
  submissionStore.set({ pending: {}, accepted: {} });
  source = null;
  try {
    sessionStorage.removeItem(sourceKey);
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const name = sessionStorage.key(i);
      if (name?.startsWith("llm-chat.submission.v1.")) sessionStorage.removeItem(name);
    }
  } catch {}
}
export function readSubmission(conversationId: string | null): Submission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(conversationId)) ?? "null") as Submission | null;
    if (value && typeof value.id === "string" && typeof value.text === "string" && typeof value.originalText === "string"
      && ["start", "send", "queue"].includes(value.kind) && ["queue", "steer"].includes(value.mode) && typeof value.prepared === "boolean"
      && Array.isArray(value.assetIds) && value.assetIds.every(id => typeof id === "string") && typeof value.input?.agentId === "string") return value;
  } catch {}
  return memory.get(key(conversationId)) ?? null;
}
export function saveSubmission(conversationId: string | null, value: Submission | null) {
  if (value) memory.set(key(conversationId), value); else memory.delete(key(conversationId));
  try { if (value) sessionStorage.setItem(key(conversationId), JSON.stringify(value)); else sessionStorage.removeItem(key(conversationId)); } catch {}
  submissionStore.set(state => {
    const pending = { ...state.pending };
    if (value) pending[conversationId ?? "new"] = { ...value }; else delete pending[conversationId ?? "new"];
    return { pending };
  });
}

export function recordSubmissionAcceptance(value: SubmissionAcceptedDto): boolean {
  if (submissionStore.get().accepted[value.clientSubmissionId]) return false;
  submissionStore.set(state => ({ accepted: { ...Object.fromEntries(Object.entries(state.accepted).slice(-99)), [value.clientSubmissionId]: value } }));
  return true;
}

/** A notification may confirm the write before its HTTP response arrives. */
export function waitForSubmission<T extends object>(id: string, request: () => Promise<T>): Promise<T & { acceptance?: SubmissionAcceptedDto }> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const receipt = submissionStore.get().accepted[id];
      if (receipt) { unsubscribe(); resolve({ ...receipt.result, acceptance: receipt } as unknown as T & { acceptance: SubmissionAcceptedDto }); }
    };
    const unsubscribe = submissionStore.subscribe(check);
    const known = submissionStore.get().accepted[id];
    if (known) { check(); return; }
    void request().then(value => { unsubscribe(); resolve({ ...value }); }, error => { unsubscribe(); reject(error); });
  });
}
