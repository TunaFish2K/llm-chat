import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { endpoints } from "./api";
import { acceptSettings, acceptSubmission, appStore, loadMessages, refreshConversations, selectBranchImmediately, selectGenerationImmediately, stopAppEvents, submitConversation, updateConversationImmediately, updateSettingsImmediately } from "./app-state";
import { makeConversation, makeGeneration, makeMessage, makeSettings } from "../../test/fixtures";
import { offlineStore } from "./offline-history";

beforeEach(() => { appStore.set({ auth: "ready", conversations: [makeConversation()], settings: makeSettings() }); offlineStore.set({ offline: false }); });
afterEach(() => stopAppEvents());

it("shows later model choices immediately while sends use the preceding saved choice", async () => {
  let confirm!: (value: ReturnType<typeof makeConversation>) => void;
  const order: string[] = [];
  vi.spyOn(endpoints, "updateConversation")
    .mockImplementationOnce(() => { order.push("first model"); return new Promise(done => { confirm = done; }); })
    .mockImplementationOnce(async () => { order.push("later model"); return makeConversation({ modelId: "later" }); });
  const first = updateConversationImmediately("conv-1", { modelId: "first" });
  const send = submitConversation("conv-1", async () => { order.push("send"); });
  const later = updateConversationImmediately("conv-1", { modelId: "later" });
  expect(appStore.get().conversations[0]?.modelId).toBe("later");
  await vi.waitFor(() => expect(order).toEqual(["first model"]));
  confirm(makeConversation({ modelId: "first" }));
  await Promise.all([first, send, later]);
  expect(order).toEqual(["first model", "send", "later model"]);
});

it("preserves failed local conversation choices across refresh and permits a manual retry", async () => {
  vi.spyOn(endpoints, "updateConversation").mockRejectedValueOnce(new Error("offline"));
  await expect(updateConversationImmediately("conv-1", { modelId: "local-model" })).rejects.toThrow("offline");
  vi.spyOn(endpoints, "conversations").mockResolvedValue([makeConversation()]);
  await refreshConversations();
  expect(appStore.get().conversations[0]?.modelId).toBe("local-model");
  const send = vi.fn(async () => {});
  await expect(submitConversation("conv-1", send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  vi.mocked(endpoints.updateConversation).mockResolvedValueOnce(makeConversation({ modelId: "local-model" }));
  await updateConversationImmediately("conv-1", { modelId: "local-model" });
  await submitConversation("conv-1", send);
  expect(send).toHaveBeenCalledOnce();
});

it("applies the latest title immediately while writes remain ordered and failed predecessors roll back only their own patch", async () => {
  let reject!: (error: Error) => void;
  const write = vi.spyOn(endpoints, "updateConversation").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValueOnce(makeConversation({ title: "newest" }));
  const first = updateConversationImmediately("conv-1", { title: "first" });
  const failure = expect(first).rejects.toThrow("rejected");
  const second = updateConversationImmediately("conv-1", { title: "newest" });
  expect(appStore.get().conversations[0]?.title).toBe("newest");
  await Promise.resolve(); await Promise.resolve();
  expect(write).toHaveBeenCalledOnce();
  reject(new Error("rejected")); await failure;
  expect(appStore.get().conversations[0]?.title).toBe("newest");
  await second; expect(write).toHaveBeenCalledTimes(2);
  expect(appStore.get().conversations[0]?.title).toBe("newest");
});

it("keeps the latest branch visible through stale refresh and rejected earlier writes", async () => {
  const root = makeConversation({ id: "root", activeBranchId: "root" });
  const firstBranch = makeConversation({ id: "branch-1", forkedFrom: { conversationId: "root", messageId: null, messageOrdinal: null, mode: "continue", greetingIndex: null, sourceGreetingIndex: null } });
  const lastBranch = { ...firstBranch, id: "branch-2" };
  const conversations = [root, firstBranch, lastBranch];
  appStore.set({ conversations });
  history.replaceState(null, "", "/c/root");
  let reject!: (error: Error) => void;
  vi.spyOn(endpoints, "selectConversationBranch").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValueOnce({ activeBranchId: "branch-2" });
  vi.spyOn(endpoints, "conversations").mockResolvedValue(conversations);
  const first = selectBranchImmediately("root", "branch-1"), failed = expect(first).rejects.toThrow("rejected");
  const second = selectBranchImmediately("root", "branch-2");
  await refreshConversations();
  expect(appStore.get().conversations[0]?.activeBranchId).toBe("branch-2");
  reject(new Error("rejected")); await failed; await second;
  expect(appStore.get().conversations[0]?.activeBranchId).toBe("branch-2");
});

it("preserves a queued version choice while an earlier selection fails and stale history returns", async () => {
  history.replaceState(null, "", "/c/conv-1");
  const message = makeMessage({ id: "select-message", activeGenerationId: "original", generations: [makeGeneration({ id: "original", status: "completed" })] });
  appStore.set({ messages: { "conv-1": [message] } });
  let reject!: (error: Error) => void, confirm!: (value: { ok: true }) => void;
  const write = vi.spyOn(endpoints, "selectGeneration").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockImplementationOnce(() => new Promise(done => { confirm = done; }));
  vi.spyOn(endpoints, "messages").mockResolvedValue([message]);
  const first = selectGenerationImmediately("conv-1", message.id, "first"), failed = expect(first).rejects.toThrow("rejected");
  const second = selectGenerationImmediately("conv-1", message.id, "latest");
  await loadMessages("conv-1");
  expect(appStore.get().messages["conv-1"]?.[0]?.activeGenerationId).toBe("latest");
  reject(new Error("rejected")); await failed;
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(appStore.get().messages["conv-1"]?.[0]?.activeGenerationId).toBe("latest");
  confirm({ ok: true }); await second;
  expect(appStore.get().messages["conv-1"]?.[0]?.activeGenerationId).toBe("latest");
});

it("keeps unsaved settings after failure and stale refresh until a manual retry succeeds", async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(endpoints, "updateSettings").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const write = updateSettingsImmediately({ lastWorkspacePath: "/pending" });
  const failed = expect(write).rejects.toThrow("offline");
  expect(appStore.get().settings?.lastWorkspacePath).toBe("/pending");
  acceptSettings(makeSettings({ lastWorkspacePath: "/stale" }));
  expect(appStore.get().settings?.lastWorkspacePath).toBe("/pending");
  await Promise.resolve(); await Promise.resolve();
  reject(new Error("offline")); await failed;
  expect(appStore.get().settings?.lastWorkspacePath).toBe("/pending");
  acceptSettings(makeSettings({ lastWorkspacePath: "/stale" }));
  expect(appStore.get().settings?.lastWorkspacePath).toBe("/pending");
  vi.mocked(endpoints.updateSettings).mockResolvedValueOnce(makeSettings({ lastWorkspacePath: "/pending" }));
  await updateSettingsImmediately({ lastWorkspacePath: "/pending" });
  acceptSettings(makeSettings({ lastWorkspacePath: "/confirmed" }));
  expect(appStore.get().settings?.lastWorkspacePath).toBe("/confirmed");
});

it("retains identity for unchanged history and preserves canonical messages accepted during a stale read", async () => {
  const { loadMessages, acceptSubmission } = await import("./app-state");
  const { makeMessage, makeGeneration } = await import("../../test/fixtures");
  history.replaceState(null, "", "/c/conv-1");
  const previous = makeMessage({ id: "old", ordinal: 1, role: "user", generations: [] });
  appStore.set({ sourceId: "source", messages: { "conv-1": [previous] } });
  let resolve!: (value: typeof previous[]) => void;
  vi.spyOn(endpoints, "messages").mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const reading = loadMessages("conv-1");
  const newMessage = makeMessage({ id: "new", ordinal: 2, role: "user", text: "accepted" });
  const assistant = makeMessage({ id: "assistant", ordinal: 3, generations: [makeGeneration({ status: "queued" })] });
  const receipt = { clientSubmissionId: crypto.randomUUID(), sourceId: "source", kind: "send" as const, conversation: makeConversation(), messages: [newMessage, assistant],
    result: { userMessageId: "new", assistantMessageId: "assistant", generationId: assistant.generations[0]!.id } };
  acceptSubmission(receipt); acceptSubmission(receipt);
  resolve([previous]); await reading;
  expect(appStore.get().messages["conv-1"]?.map(message => message.id)).toEqual(["old", "new", "assistant"]);
  expect(appStore.get().messages["conv-1"]?.[0]).toBe(previous);
});

it("retains new retry generations and streamed text when a preceding GET completes", async () => {
  history.replaceState(null, "", "/c/conv-1");
  const previous = makeMessage({ generations: [makeGeneration({ id: "old", status: "completed" })], activeGenerationId: "old" });
  appStore.set({ messages: { "conv-1": [previous] } });
  let resolve!: (value: typeof previous[]) => void;
  vi.spyOn(endpoints, "messages").mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const reading = loadMessages("conv-1");
  const current = { ...previous, activeGenerationId: "retry", generations: [...previous.generations, makeGeneration({ id: "retry", status: "running" })] };
  appStore.set({ messages: { "conv-1": [current] } });
  resolve([previous]); await reading;
  expect(appStore.get().messages["conv-1"]?.[0]?.activeGenerationId).toBe("retry");
  expect(appStore.get().messages["conv-1"]?.[0]?.generations).toEqual(current.generations);
});

it("retains both canonical messages when a new conversation is accepted before navigation", () => {
  history.replaceState(null, "", "/");
  appStore.set({ sourceId: "source", messages: {} });
  const user = makeMessage({ id: "accepted-user", ordinal: 1, role: "user", generations: [] });
  const assistant = makeMessage({ id: "accepted-assistant", ordinal: 2, generations: [makeGeneration({ status: "queued" })] });
  const conversation = makeConversation({ id: "accepted-conversation" });
  acceptSubmission({ clientSubmissionId: crypto.randomUUID(), sourceId: "source", kind: "start", conversation, messages: [user, assistant],
    result: { conversation, generation: { userMessageId: user.id, assistantMessageId: assistant.id, generationId: assistant.generations[0]!.id } } });
  expect(location.pathname).toBe("/");
  expect(appStore.get().messages[conversation.id]?.map(message => message.id)).toEqual([user.id, assistant.id]);
});
