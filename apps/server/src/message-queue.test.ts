import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { GenerationRunner } from "./generations";
import { EventHub } from "./events";
import { MessageQueue } from "./message-queue";
import type { ImageService } from "./images";

afterEach(cleanupStores);
function setup() {
  const store = createStore();
  const { model } = seedModel(store);
  const first = store.startConversation({ text: "first", modelId: model.id, contextPolicy: "full" });
  return { store, conversationId: first.conversation.id, first: first.generation };
}
function service(store: Store) {
  const images = { materializeMessageAttachments: vi.fn(async () => {}) } as unknown as ImageService;
  const events = new EventHub();
  const runner = new GenerationRunner(store, {
    onSettled: (id) => queue.kick(id), buildTools: async () => [], memoryPrompt: () => "",
    buildContext: async () => ({ systemPrompt: "", messages: [], metadata: { policy: "full", omittedMessages: 0, estimatedInputTokens: 0, summaryUsed: false } }),
    stream: async function* () { yield { type: "complete", stopReason: "stop" }; }
  });
  const queue = new MessageQueue(store, runner, images, events, () => {});
  return { queue, runner, images, events };
}

it("persists order and attachments, supports deleting some/all, and protects referenced assets", () => {
  const { store, conversationId, first } = setup();
  const asset = store.createFileAsset({ sha256: "a".repeat(64), fileName: "file.txt", mimeType: "text/plain", kind: "file", byteSize: 2, storageKey: "test" });
  store.updateConversation(conversationId, { draft: "a" });
  const a = store.enqueueMessage(conversationId, "a", [asset.id]);
  expect(store.getConversation(conversationId)?.draft).toBe("");
  const b = store.enqueueMessage(conversationId, "b", []);
  store.enqueueMessage(conversationId, "c", []);
  expect(store.dispatchQueuedMessage(conversationId, () => {})).toBeNull();
  expect(store.unreferencedFileAssets(Date.now() + 1)).toEqual([]);
  store.deleteQueuedMessages(conversationId, b.id);
  expect(store.listQueuedMessages(conversationId).map((item) => item.text)).toEqual(["a", "c"]);
  store.finishGeneration(first.generationId, "stopped", {});
  store.updateConversation(conversationId, { draft: "unsent draft" });
  const result = store.dispatchQueuedMessage(conversationId, () => {})!;
  expect(store.listMessages(conversationId).find((item) => item.id === result.userMessageId)?.attachments[0]?.id).toBe(asset.id);
  expect(store.getConversation(conversationId)?.draft).toBe("unsent draft");
  expect(() => store.deleteQueuedMessages(conversationId, a.id)).toThrow("已经开始发送");
  store.deleteQueuedMessages(conversationId);
  expect(store.listQueuedMessages(conversationId).map((item) => item.id)).toEqual([a.id]);
});

it("records a failed dispatch without inserting partial history, then processes later items", async () => {
  const { store, conversationId, first } = setup();
  store.finishGeneration(first.generationId, "failed", {});
  store.enqueueMessage(conversationId, "bad", []);
  store.enqueueMessage(conversationId, "good", []);
  expect(store.dispatchQueuedMessage(conversationId, () => { throw new Error("configuration changed"); })).toBeNull();
  expect(store.listMessages(conversationId)).toHaveLength(2);
  expect(store.listQueuedMessages(conversationId)[0]).toMatchObject({ status: "failed", error: "configuration changed" });
  const { queue, runner } = service(store);
  queue.kick(conversationId);
  await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.generations[0]?.status).toBe("completed"));
  expect(store.listQueuedMessages(conversationId)).toHaveLength(1);
  await queue.close(); await runner.close();
});

it("drains several messages after cancellation, including synchronous completions", async () => {
  const { store, conversationId, first } = setup();
  store.setGenerationWaitingApproval(first.generationId);
  for (const text of ["a", "b", "c"]) store.enqueueMessage(conversationId, text, []);
  const { queue, runner } = service(store);
  expect(runner.cancel(first.generationId)).toBe(true);
  await vi.waitFor(() => expect(store.listMessages(conversationId)).toHaveLength(8));
  await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.generations[0]?.status).toBe("completed"));
  expect(store.listMessages(conversationId).filter((item) => item.role === "user").map((item) => item.text)).toEqual(["first", "a", "b", "c"]);
  expect(store.listQueuedMessages(conversationId)).toEqual([]);
  await queue.close(); await runner.close();
});

it("recovers committed but never started dispatches after restart without duplicate messages", async () => {
  const { store, conversationId, first } = setup();
  store.finishGeneration(first.generationId, "completed", {});
  store.enqueueMessage(conversationId, "after restart", []);
  const dispatched = store.dispatchQueuedMessage(conversationId, () => {})!;
  const path = join(store.dataDir, "test.sqlite"); store.close();
  const reopened = new Store(path);
  const { queue, runner } = service(reopened);
  try {
    queue.initialize();
    await vi.waitFor(() => expect(reopened.getGeneration(dispatched.generationId)?.status).toBe("completed"));
    expect(reopened.listMessages(conversationId)).toHaveLength(4);
    expect(reopened.listQueuedMessages(conversationId)).toEqual([]);
  } finally { await queue.close(); await runner.close(); reopened.close(); }
});

it("retains attachment preparation failures and continues with the next queued message", async () => {
  const { store, conversationId, first } = setup();
  store.finishGeneration(first.generationId, "completed", {});
  store.enqueueMessage(conversationId, "bad attachment", []);
  store.enqueueMessage(conversationId, "next", []);
  const { queue, runner, images } = service(store);
  vi.mocked(images.materializeMessageAttachments).mockRejectedValueOnce(new Error("file missing"));
  queue.kick(conversationId);
  await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.generations[0]?.status).toBe("completed"));
  expect(store.listQueuedMessages(conversationId)).toMatchObject([{ status: "failed", error: "file missing" }]);
  expect(store.listMessages(conversationId)[3]?.generations[0]).toMatchObject({ status: "failed", error: { code: "queue_attachment_failed" } });
  await queue.close(); await runner.close();
});

it("cancels a dispatch during attachment preparation without starting it later", async () => {
  const { store, conversationId, first } = setup();
  store.finishGeneration(first.generationId, "completed", {});
  store.enqueueMessage(conversationId, "cancel me", []);
  store.enqueueMessage(conversationId, "next", []);
  const { queue, runner, images } = service(store);
  let release!: () => void;
  vi.mocked(images.materializeMessageAttachments).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  queue.kick(conversationId);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const id = store.listQueuedMessages(conversationId)[0]!.generationId!;
  expect(runner.cancel(id)).toBe(true);
  release();
  await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.generations[0]?.status).toBe("completed"));
  expect(store.getGeneration(id)?.status).toBe("stopped");
  expect(store.listQueuedMessages(conversationId)).toEqual([]);
  await queue.close(); await runner.close();
});
