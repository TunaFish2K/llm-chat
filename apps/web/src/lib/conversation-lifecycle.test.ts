import { expect, it, vi } from "vitest";
import { makeConversation, makeMessage } from "../../test/fixtures";
import { appStore, loadMessages, reconcileConversations, toastError, trackGeneration, upsertMessage } from "./app-state";
import { conversationDeleted, localDeletions, markConversationsDeleted } from "./conversation-lifecycle";
import { readComposerDraft, recoveredDraftIds, scheduleServerDraft, swapRecoveredDraft, writeComposerDraft, type ComposerDraft } from "./composer-drafts";
import { endpoints } from "./api";
import { FakeEventSource } from "../../test/setup";

const draft: ComposerDraft = { text: "unsent", attachments: [], agentId: null, overrides: {}, workspace: "/tmp", greetingIndex: 2 };

it("removes descendants, closes streams and retains both drafts with one notification", async () => {
  const root = makeConversation({ id: "root" });
  const child = makeConversation({ id: "child", forkedFrom: { conversationId: root.id, messageId: null, messageOrdinal: null, mode: "continue", greetingIndex: null, sourceGreetingIndex: null } });
  window.history.replaceState(null, "", "/c/child");
  appStore.set({ conversations: [root, child], messages: { child: [makeMessage()] }, toasts: [], runningTasksByConversation: { child: 1 } });
  writeComposerDraft(null, { ...draft, text: "original" });
  writeComposerDraft(child.id, draft);
  const save = vi.spyOn(endpoints, "updateConversation");
  scheduleServerDraft(child.id, draft.text);
  trackGeneration(child.id, "message", "generation");
  const stream = FakeEventSource.instances.at(-1)!;
  markConversationsDeleted([root.id]);
  markConversationsDeleted([root.id, child.id]);
  toastError(Object.assign(new Error("会话不存在"), { code: "conversation_not_found" }));
  expect(location.pathname).toBe("/");
  expect(appStore.get()).toMatchObject({ conversations: [], messages: {}, runningTasksByConversation: {} });
  expect(appStore.get().toasts.map((item) => item.text)).toEqual(["会话已删除"]);
  expect(stream.closed).toBe(true);
  expect(conversationDeleted(child.id)).toBe(true);
  expect(readComposerDraft(child.id)).toBeNull();
  expect(readComposerDraft(null)).toEqual(draft);
  expect(recoveredDraftIds()).toHaveLength(1);
  expect(swapRecoveredDraft()?.text).toBe("original");
  expect(swapRecoveredDraft()?.text).toBe("unsent");
  expect(save).not.toHaveBeenCalled();
});

it("rejects a late message response and later stream updates", async () => {
  const id = "late";
  appStore.set({ conversations: [makeConversation({ id })], messages: {}, toasts: [] });
  let resolve!: (messages: ReturnType<typeof makeMessage>[]) => void;
  vi.spyOn(endpoints, "messages").mockImplementation(() => new Promise((done) => { resolve = done; }));
  const request = loadMessages(id);
  markConversationsDeleted([id]);
  resolve([makeMessage()]);
  await request;
  upsertMessage(id, makeMessage());
  expect(appStore.get().messages[id]).toBeUndefined();
  expect(appStore.get().toasts).toHaveLength(0);
});

it("does not add the remote deletion toast for a local delete", () => {
  const id = "local";
  appStore.set({ conversations: [makeConversation({ id })], messages: {}, toasts: [] });
  window.history.replaceState(null, "", "/c/local");
  localDeletions.add(id);
  reconcileConversations([]);
  localDeletions.delete(id);
  expect(location.pathname).toBe("/");
  expect(appStore.get().toasts).toHaveLength(0);
});

it("treats only a structured missing-conversation response as deletion and aborts pending requests", async () => {
  const id = crypto.randomUUID();
  let aborted = false;
  const fetch = vi.fn().mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "conversation_not_found", message: "会话不存在" } }), { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const pending = endpoints.messages(id).catch((error) => error);
  await expect(endpoints.queueState(id)).rejects.toMatchObject({ code: "conversation_not_found" });
  expect(await pending).toMatchObject({ code: "conversation_deleted_local" });
  expect(aborted).toBe(true);
  await expect(endpoints.messages(id)).rejects.toMatchObject({ code: "conversation_deleted_local" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not mark a conversation created after a manifest request as deleted", () => {
  const old = makeConversation({ id: "old" });
  const created = makeConversation({ id: "created-during-sync" });
  appStore.set({ conversations: [old, created], messages: {}, toasts: [] });
  window.history.replaceState(null, "", "/");
  reconcileConversations([old], null, [old.id]);
  expect(conversationDeleted(created.id)).toBe(false);
  expect(appStore.get().conversations).toContainEqual(created);
});
