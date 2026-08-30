import { afterEach, describe, expect, it } from "vitest";
import { buildContext, estimateTokens } from "./context";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);

describe("context builder", () => {
  it("uses a conservative UTF-8 estimate for Chinese and English", () => {
    expect(estimateTokens("", [{ role: "user", text: "中文测试" }])).toBeGreaterThan(4);
    expect(estimateTokens("", [{ role: "user", text: "a long english sentence" }])).toBeGreaterThan(6);
  });

  it("trims complete old turns while preserving the latest user message", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const model = store.updateModel(seeded.model.id, { contextWindow: 512 })!;
    const conversation = store.createConversation({ systemPrompt: "", contextPolicy: "trim" });
      const first = store.createMessageGeneration(conversation.id, "旧问题".repeat(60));
    store.setGenerationRunning(first.generationId);
    store.updateGenerationBlock(first.generationId, 1, "text", "旧答案".repeat(60), true);
    store.finishGeneration(first.generationId, "completed", { stopReason: "stop" });
    const latest = store.createMessageGeneration(conversation.id, "最新问题");
    const record = store.getGenerationRecord(latest.generationId)!;
    const connection = store.getConnection(seeded.connection.id)!;
    const built = await buildContext(store, record, model, connection, new AbortController().signal);
    expect(built.metadata.omittedMessages).toBeGreaterThan(0);
    expect(built.messages.at(-1)?.text).toBe("最新问题");
    store.close();
  });
});
