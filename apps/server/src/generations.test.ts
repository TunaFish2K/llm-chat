import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationRunner } from "./generations";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupStores();
});

describe("GenerationRunner live subscriptions", () => {
  it("replays the latest reasoning block to a subscriber that joins late", async () => {
    let releaseStream!: () => void;
    const release = new Promise<void>((resolve) => { releaseStream = resolve; });
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先思考" } }] })}\n\n`));
        void release.then(() => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "再回答" }, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } })));

    const store = createStore();
    const { model } = seedModel(store);
    store.updateModel(model.id, { capabilities: { ...model.capabilities, reasoning: true } });
    store.updateSettings({ reasoningEffort: "high" });
    const started = store.startConversation({ text: "测试", modelId: model.id });
    const runner = new GenerationRunner(store);

    runner.start(started.generation.generationId);
    const firstReasoning = new Promise<void>((resolve) => {
      const unsubscribe = runner.subscribe(started.generation.generationId, (event) => {
        if (event.type === "block-delta" && event.block.type === "reasoning") {
          unsubscribe();
          resolve();
        }
      });
    });
    await firstReasoning;

    const replayed: string[] = [];
    const unsubscribeLate = runner.subscribe(started.generation.generationId, (event) => {
      if (event.type === "block-delta" && event.block.type === "reasoning") replayed.push(event.block.content);
    });
    expect(replayed).toEqual(["先思考"]);

    unsubscribeLate();
    releaseStream();
    await waitFor(() => store.getGeneration(started.generation.generationId)?.status === "completed");
    runner.stopAll();
    store.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for generation");
}
