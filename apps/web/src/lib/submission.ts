/** Manual retries keep an immutable request, including across a page reload. */
export interface Submission {
  id: string;
  kind: "start" | "send" | "queue";
  text: string;
  assetIds: string[];
  mode: "queue" | "steer";
  input: { agentId: string; greetingIndex: number; executionOverrides: import("@llm-chat/contracts").ConversationExecutionOverrides; workspacePath: string | null };
  originalText: string;
  prepared: boolean;
}
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
}
