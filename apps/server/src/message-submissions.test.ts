import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store } from "./database";
import { MessageSubmissions } from "./message-submissions";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
afterEach(cleanupStores);

it("coalesces concurrent starts and persists delivery receipts across restart", async () => {
  const store = createStore(), { model } = seedModel(store), service = new MessageSubmissions(store);
  const value = { clientRequestId: randomUUID(), text: "hello", modelId: model.id };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const action = vi.fn(async (input) => { const result = store.startConversation(value, input); await gate; return result; });
  const a = service.run("start", null, value, action), b = service.run("start", null, value, action);
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  finish(); const result = await a;
  expect(await b).toEqual(result);
  expect(store.listMessages(result.conversation.id)[0]?.clientRequestId).toBe(value.clientRequestId);
  const path = join(store.dataDir, "test.sqlite"); store.close();
  const reopened = new Store(path);
  try {
    const replay = await new MessageSubmissions(reopened).run("start", null, value, async () => { throw new Error("must not create again"); });
    expect(replay).toEqual(result);
    expect(reopened.listConversations()).toHaveLength(1);
  } finally { reopened.close(); }
});

it("rejects conflicting payloads while preparing and after committing", async () => {
  const store = createStore(), { model } = seedModel(store), service = new MessageSubmissions(store);
  const value = { clientRequestId: randomUUID(), text: "hello", modelId: model.id };
  let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = service.run("start", null, value, async (input) => { const result = store.startConversation(value, input); await gate; return result; });
  await expect(service.run("start", null, { ...value, text: "different" }, async () => null)).rejects.toMatchObject({ code: "submission_conflict" });
  finish(); await first;
  await expect(service.run("start", null, { ...value, text: "different" }, async () => null)).rejects.toMatchObject({ code: "submission_conflict" });
});

it("retains queue receipts after dispatch and never re-enqueues delivered messages", async () => {
  const store = createStore(), { model } = seedModel(store), service = new MessageSubmissions(store);
  const first = store.startConversation({ text: "first", modelId: model.id });
  const id = first.conversation.id, value = { clientRequestId: randomUUID(), text: "queued" };
  const action = vi.fn(async (input) => store.enqueueMessage(id, value.text, [], "queue", input));
  const item = await service.run("queue", id, value, action);
  store.finishGeneration(first.generation.generationId, "completed", {});
  const dispatched = store.dispatchQueuedMessage(id, () => {})!;
  store.sqlite.prepare("DELETE FROM queued_messages WHERE id = ?").run(item.id);
  expect(store.getSubmission(value.clientRequestId)).toMatchObject({ ...dispatched, deleted: false, queuedMessageId: item.id });
  expect(await service.run("queue", id, value, action)).toMatchObject({ id: item.id, generationId: dispatched.generationId });
  expect(action).toHaveBeenCalledTimes(1);
  expect(store.listMessages(id).filter((message) => message.text === "queued")).toHaveLength(1);
});

it("keeps a tombstone after queue deletion", async () => {
  const store = createStore(), { model } = seedModel(store), service = new MessageSubmissions(store);
  const first = store.startConversation({ text: "first", modelId: model.id });
  const id = first.conversation.id, value = { clientRequestId: randomUUID(), text: "queued" };
  const action = vi.fn(async (input) => store.enqueueMessage(id, value.text, [], "queue", input));
  const item = await service.run("queue", id, value, action);
  store.deleteQueuedMessages(id, item.id);
  expect(store.getSubmission(value.clientRequestId)?.deleted).toBe(true);
  await expect(service.run("queue", id, value, action)).rejects.toMatchObject({ code: "submission_deleted" });
  expect(action).toHaveBeenCalledTimes(1);
});

it("rolls back a failed creation together with its receipt", async () => {
  const store = createStore(), { model } = seedModel(store), service = new MessageSubmissions(store);
  const value = { clientRequestId: randomUUID(), text: "hello", modelId: model.id, assetIds: [randomUUID()] };
  await expect(service.run("start", null, value, async (input) => store.startConversation(value, input))).rejects.toThrow();
  expect(store.getSubmission(value.clientRequestId)).toBeUndefined();
  expect(store.listConversations()).toEqual([]);
});
