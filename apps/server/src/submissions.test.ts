import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { Store } from "./database";

afterEach(cleanupStores);

it("atomically retains a message receipt across restart and rejects changed input", () => {
  const store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const payload = { text: "once" };
  const result = store.acceptSubmission("receipt", "send", payload, () => store.createMessageGeneration(conversation.id, "once"));
  expect(store.acceptSubmission("receipt", "send", payload, () => { throw new Error("must not run twice"); })).toEqual(result);
  expect(store.listMessages(conversation.id)).toHaveLength(2);
  expect(() => store.acceptSubmission("receipt", "send", { text: "changed" }, () => null)).toThrow("提交内容已变化");
  const path = join(store.dataDir, "test.sqlite"); store.close();
  const reopened = new Store(path);
  try {
    expect(reopened.submissionResult("receipt", "send", payload)?.value).toEqual(result);
    expect(reopened.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 49 });
  } finally { reopened.close(); }
});

it("rolls back both the nested business transaction and receipt on failure", () => {
  const store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  expect(() => store.acceptSubmission("fail", "send", {}, () => {
    store.createMessageGeneration(conversation.id, "rollback");
    throw new Error("failed after insert");
  })).toThrow("failed after insert");
  expect(store.listMessages(conversation.id)).toEqual([]);
  expect(store.submissionResult("fail", "send", {})).toBeNull();
  expect(store.acceptSubmission(undefined, "legacy", {}, () => "legacy")).toBe("legacy");
  expect(store.submissionResult(undefined, "legacy", {})).toBeNull();
});
