import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);
it("preserves legacy hidden messages and attachments through new turns, forks and restart", () => {
  const store = createStore(); const { model } = seedModel(store);
  const started = store.startConversation({ text: "visible", modelId: model.id, contextPolicy: "full" });
  const id = started.conversation.id;
  store.finishGeneration(started.generation.generationId, "completed", {});
  const hidden = store.createMessageGeneration(id, "legacy hidden text");
  store.finishGeneration(hidden.generationId, "completed", {});
  const oldMessages = store.listMessages(id).slice(2);
  const asset = store.createFileAsset({ sha256: "b".repeat(64), fileName: "old.txt", mimeType: "text/plain", kind: "file", byteSize: 2, storageKey: "blob" });
  store.attachFilesToMessage(oldMessages[0]!.id, [asset.id]);
  for (const message of oldMessages) store.sqlite.prepare("UPDATE messages SET history_active = 0 WHERE id = ?").run(message.id);
  store.sqlite.prepare("INSERT INTO conversation_history VALUES (?, ?, ?, 1, 1, ?)").run("legacy", id, JSON.stringify(oldMessages.map(m => m.id)), Date.now());
  store.sqlite.prepare("UPDATE conversations SET queue_paused = 1 WHERE id = ?").run(id);
  store.enqueueMessage(id, "later", [], "steer");
  const next = store.createMessageGeneration(id, "new turn");
  store.finishGeneration(next.generationId, "completed", {});
  const fork = store.forkConversation(id, { mode: "continue", throughMessageId: null }).conversation;
  expect(store.listMessages(fork.id).some(m => m.text === "legacy hidden text")).toBe(false);
  expect(store.allContextMessages(id).some(m => m.text === "legacy hidden text")).toBe(false);
  expect(store.searchChats("legacy hidden text", 10)).toEqual([]);
  expect(store.unreferencedFileAssets(Date.now() + 1000)).toEqual([]);
  expect(store.dispatchQueuedMessage(id, () => {})).toBeNull();
  const path = join(store.dataDir, "test.sqlite"); store.close();
  const reopened = new Store(path);
  try {
    expect(reopened.sqlite.prepare("SELECT count(*) AS n FROM conversation_history").get()?.n).toBe(1);
    expect(reopened.listMessages(id, true).filter(m => oldMessages.some(old => old.id === m.id))).toHaveLength(2);
    expect(reopened.listMessages(id, true).find(m => m.id === oldMessages[0]!.id)?.attachments[0]?.id).toBe(asset.id);
    expect(reopened.isQueuePaused(id)).toBe(true);
    reopened.resumeQueue(id);
    expect(reopened.dispatchQueuedMessage(id, () => {})).not.toBeNull();
  } finally { reopened.close(); }
});
