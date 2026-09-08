import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { ConversationHistory } from "./conversation-history";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);
function setup() {
  const store = createStore(); const { model } = seedModel(store);
  const started = store.startConversation({ text: "A", modelId: model.id, contextPolicy: "full" });
  const id = started.conversation.id;
  store.finishGeneration(started.generation.generationId, "completed", {});
  for (const text of ["B", "C"]) {
    const generation = store.createMessageGeneration(id, text);
    store.finishGeneration(generation.generationId, "completed", {});
  }
  return { store, id, history: new ConversationHistory(store) };
}

it("rewinds without forks, excludes hidden context and search, and redoes original IDs", () => {
  const { store, id, history } = setup();
  const original = store.listMessages(id);
  const count = store.listConversations().length;
  store.saveSummary({ conversationId: id, throughOrdinal: original.at(-1)!.ordinal, fingerprint: "old", text: "includes C", connectionId: "test", modelKey: "test", usage: {} });
  const first = history.change(id, { action: "undo", revision: history.state(id).revision });
  expect(store.getContextSummary(id)).toBeUndefined();
  expect(store.listMessages(id).map((message) => message.id)).toEqual(original.slice(0, 4).map((message) => message.id));
  expect(store.allContextMessages(id).map((message) => message.messageId)).toEqual(original.slice(0, 4).map((message) => message.id));
  expect(store.searchChats("C", 10)).toEqual([]);
  expect(store.listConversations()).toHaveLength(count);
  const second = history.change(id, { action: "undo", revision: first.revision });
  expect(store.listMessages(id)).toHaveLength(2);
  const third = history.change(id, { action: "redo", revision: second.revision });
  expect(store.listMessages(id)).toHaveLength(4);
  history.change(id, { action: "redo", revision: third.revision });
  expect(store.listMessages(id)).toEqual(original);
  expect(history.state(id).records).toEqual([]);
});

it("new content ends redo but retains recoverable messages and attachments across restarts", () => {
  const { store, id, history } = setup();
  const asset = store.createFileAsset({ sha256: "b".repeat(64), fileName: "note.txt", mimeType: "text/plain", kind: "file", byteSize: 2, storageKey: "blob" });
  const lastUser = store.listMessages(id)[4]!;
  store.attachFilesToMessage(lastUser.id, [asset.id]);
  history.change(id, { action: "undo", revision: history.state(id).revision });
  const next = store.createMessageGeneration(id, "D");
  store.finishGeneration(next.generationId, "completed", {});
  expect(history.state(id).canRedo).toBe(false);
  expect(history.state(id).records[0]?.messages[0]?.attachments[0]?.id).toBe(asset.id);
  expect(store.unreferencedFileAssets(Date.now() + 1000)).toEqual([]);
  expect(store.allContextMessages(id).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["A", "B", "D"]);
  const path = join(store.dataDir, "test.sqlite"); store.close();
  const reopened = new Store(path);
  try { expect(new ConversationHistory(reopened).state(id).records[0]?.messages[0]?.id).toBe(lastUser.id); }
  finally { reopened.close(); }
});

it("rewinds to a complete turn and rejects stale or invisible targets atomically", () => {
  const { store, id, history } = setup();
  const original = store.listMessages(id);
  const revision = history.state(id).revision;
  history.change(id, { action: "rewind", throughMessageId: original[1]!.id, revision });
  expect(store.listMessages(id)).toHaveLength(2);
  expect(() => history.change(id, { action: "undo", revision })).toThrow("对话已在其他操作中改变");
  expect(() => history.change(id, { action: "rewind", throughMessageId: original[3]!.id, revision: history.state(id).revision })).toThrow("回溯位置不存在");
  expect(() => store.createRetryGeneration(original[3]!.id)).toThrow("助手消息不存在");
  expect(store.selectGeneration(original[3]!.id, original[3]!.activeGenerationId!)).toBe(false);
  expect(store.listMessages(id)).toHaveLength(2);
});

it("keeps queued messages paused through rewind and rejects active generations", () => {
  const { store, id, history } = setup();
  store.enqueueMessage(id, "later", []);
  history.pause(id, true);
  history.change(id, { action: "undo", revision: history.state(id).revision });
  expect(store.dispatchQueuedMessage(id, () => {})).toBeNull();
  expect(store.listQueuedMessages(id)).toHaveLength(1);
  const manual = store.createMessageGeneration(id, "manual after rewind");
  expect(() => history.change(id, { action: "undo", revision: history.state(id).revision })).toThrow("等待当前生成停止");
  store.finishGeneration(manual.generationId, "completed", {});
  history.pause(id, false);
  expect(store.dispatchQueuedMessage(id, () => {})).not.toBeNull();
});
