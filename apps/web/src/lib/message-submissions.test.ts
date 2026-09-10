import { beforeEach, expect, it, vi } from "vitest";
import { beginSubmission, submitPending, submissionStore, restoreSubmissions, takeSubmissionDraft, reconcileSubmission } from "./message-submissions";
import { ApiRequestError, endpoints } from "./api";
import { appStore } from "./app-state";
import { makeConversation, makeMessage } from "../../test/fixtures";
import { readComposerDraft, writeComposerDraft } from "./composer-drafts";
const draft = { text: "hello", attachments: [], agentId: "agent-1", overrides: {}, workspace: null, greetingIndex: 0 };
beforeEach(() => {
  sessionStorage.clear(); window.dispatchEvent(new Event("llm-chat:submissions-clear"));
  appStore.set({ conversations: [makeConversation()], messages: {} });
  vi.spyOn(endpoints, "conversations").mockImplementation(async () => appStore.get().conversations);
});

it("keeps the same identity and payload when a lost response is retried", async () => {
  const send = vi.spyOn(endpoints, "sendMessage").mockRejectedValueOnce(new ApiRequestError(0, "network_error", "lost"))
    .mockResolvedValueOnce({ userMessageId: "u", assistantMessageId: "a", generationId: "g" });
  vi.spyOn(endpoints, "messages").mockResolvedValue([makeMessage({ id: "u", role: "user", text: "hello" })]);
  const item = beginSubmission("conv-1", draft, "send", "queue");
  await submitPending(item.id, { text: "hello", agentId: "agent-1" });
  expect(submissionStore.get().items[0]?.status).toBe("unknown");
  restoreSubmissions(); await submitPending(item.id);
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect(send.mock.calls[0]?.[3]).toBe(item.id);
  expect(submissionStore.get().items).toEqual([]);
});

it("never resends accepted work when history refresh fails", async () => {
  const send = vi.spyOn(endpoints, "sendMessage").mockResolvedValue({ userMessageId: "u", assistantMessageId: "a", generationId: "g" });
  vi.spyOn(endpoints, "messages").mockRejectedValue(new Error("refresh failed"));
  const item = beginSubmission("conv-1", draft, "send", "queue");
  await submitPending(item.id, { text: "hello", agentId: "agent-1" });
  expect(submissionStore.get().items[0]).toMatchObject({ status: "accepted", error: "消息已接受，暂时无法刷新记录" });
  vi.spyOn(endpoints, "submission").mockResolvedValue(submissionStore.get().items[0]!.receipt!);
  await reconcileSubmission(item.id).catch(() => {});
  expect(send).toHaveBeenCalledTimes(1);
});

it("recovers a failed message without overwriting the next draft", async () => {
  vi.spyOn(endpoints, "sendMessage").mockRejectedValue(new ApiRequestError(400, "invalid", "rejected"));
  const item = beginSubmission("conv-1", draft, "send", "queue");
  writeComposerDraft("conv-1", { ...draft, text: "next" });
  await submitPending(item.id, { text: "hello", agentId: "agent-1" });
  expect(readComposerDraft("conv-1")?.text).toBe("next");
  expect(takeSubmissionDraft(item.id)?.text).toBe("hello");
  const recovered = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!).find((key) => key.includes("recovered-"));
  expect(JSON.parse(sessionStorage.getItem(recovered!)!).text).toBe("next");
});

it("routes a definitive busy response to the queue once and retains its submission identity", async () => {
  vi.spyOn(endpoints, "sendMessage").mockRejectedValue(new ApiRequestError(400, "conversation_busy", "busy"));
  const enqueue = vi.spyOn(endpoints, "enqueueMessage").mockResolvedValue({ id: "q", conversationId: "conv-1", text: "hello", attachments: [], status: "pending", error: null, createdAt: 1, generationId: null });
  vi.spyOn(endpoints, "messages").mockResolvedValue([]);
  const item = beginSubmission("conv-1", draft, "send", "steer");
  await submitPending(item.id, { text: "hello", agentId: "agent-1" });
  expect(enqueue).toHaveBeenCalledWith("conv-1", "hello", [], "steer", item.id);
});
