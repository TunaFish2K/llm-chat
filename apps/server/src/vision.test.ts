import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFor, type ProviderAdapter } from "@llm-chat/providers";
import { ImageService } from "./images";
import { VisionService } from "./vision";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

vi.mock("@llm-chat/providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@llm-chat/providers")>(),
  adapterFor: vi.fn()
}));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

afterEach(() => {
  vi.mocked(adapterFor).mockReset();
  cleanupStores();
});

describe("VisionService", () => {
  it("caches fallback descriptions globally and audits each generation", async () => {
    const store = createStore();
    const { model: main } = seedModel(store);
    const connection = store.createConnection({
      name: "Vision", protocol: "openai-chat", baseUrl: "https://vision.test/v1", apiKey: "key", secretHeaders: {}
    });
    const vision = store.createModel({
      connectionId: connection.id,
      modelKey: "vision-model",
      displayName: "Vision Model",
      contextWindow: 4096,
      maxOutputTokens: 2048,
      capabilities: {
        imageInput: true, tools: false, temperature: true, topP: true, reasoning: false,
        reasoningSummary: false, adaptiveThinking: false, manualThinking: false
      },
      defaultSettings: { common: { maxOutputTokens: 2048, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    store.updateAgent(agent.id, { execution: { ...agent.execution, visionModelId: vision.id } });
    const images = new ImageService(store);
    await images.initialize();
    const asset = await images.importBytes("screen.png", PNG);
    const adapter: ProviderAdapter = {
      protocol: "openai-chat",
      listModels: async () => [],
      async *stream() {
        yield { type: "block", index: 1, blockType: "text", content: "A terminal showing fastfetch.", complete: true } as const;
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as const;
        yield { type: "complete", stopReason: "stop" } as const;
      }
    };
    vi.mocked(adapterFor).mockReturnValue(adapter);
    const service = new VisionService(store, images);

    const firstConversation = store.createConversation({ systemPrompt: "" });
    const first = store.createMessageGeneration(firstConversation.id, "What is this?", [asset.id]);
    const firstEvents: string[] = [];
    const firstPrepared = await service.prepare(
      store.getGenerationRecord(first.generationId)!, main, new AbortController().signal,
      (analysis) => firstEvents.push(`${analysis.status}:${analysis.cached}`)
    );
    expect(firstPrepared.get(asset.id)?.description).toBe("A terminal showing fastfetch.");
    expect(firstEvents).toEqual(["running:false", "completed:false", "completed:false"]);
    expect(store.getGeneration(first.generationId)?.visionAnalyses).toEqual([
      expect.objectContaining({ description: "A terminal showing fastfetch.", cached: false, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    ]);

    const secondConversation = store.createConversation({ systemPrompt: "" });
    const second = store.createMessageGeneration(secondConversation.id, "And now?", [asset.id]);
    const secondPrepared = await service.prepare(
      store.getGenerationRecord(second.generationId)!, main, new AbortController().signal,
      () => undefined
    );
    expect(secondPrepared.get(asset.id)?.description).toBe("A terminal showing fastfetch.");
    expect(adapterFor).toHaveBeenCalledTimes(1);
    expect(store.getGeneration(second.generationId)?.visionAnalyses).toEqual([
      expect.objectContaining({ cached: true, description: "A terminal showing fastfetch." })
    ]);
  });

  it("passes image bytes directly when the main model supports images", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const main = store.updateModel(seeded.model.id, {
      capabilities: { ...seeded.model.capabilities, imageInput: true }
    })!;
    const images = new ImageService(store);
    await images.initialize();
    const asset = await images.importBytes("screen.png", PNG);
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "Look", [asset.id]);

    const prepared = await new VisionService(store, images).prepare(
      store.getGenerationRecord(created.generationId)!, main, new AbortController().signal,
      () => undefined
    );
    expect(prepared.get(asset.id)?.image).toMatchObject({ mimeType: "image/png", fileName: "screen.png" });
    expect(prepared.get(asset.id)?.image?.dataBase64).toBe(Buffer.from(PNG).toString("base64"));
    expect(store.getGeneration(created.generationId)?.visionAnalyses).toEqual([]);
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it("keeps the newest images direct and describes older images when the model has a limit", async () => {
    const store = createStore();
    const seeded = seedModel(store);
    const main = store.updateModel(seeded.model.id, {
      capabilities: { ...seeded.model.capabilities, imageInput: true, maxImageInputs: 1 }
    })!;
    const connection = store.createConnection({
      name: "Vision", protocol: "openai-chat", baseUrl: "https://vision.test/v1", apiKey: "key", secretHeaders: {}
    });
    const vision = store.createModel({
      connectionId: connection.id,
      modelKey: "vision-model",
      displayName: "Vision Model",
      contextWindow: 4096,
      maxOutputTokens: 2048,
      capabilities: {
        imageInput: true, tools: false, temperature: true, topP: true, reasoning: false,
        reasoningSummary: false, adaptiveThinking: false, manualThinking: false
      },
      defaultSettings: { common: { maxOutputTokens: 2048, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    store.updateAgent(agent.id, { execution: { ...agent.execution, visionModelId: vision.id } });
    const images = new ImageService(store);
    await images.initialize();
    const oldest = await images.importBytes("old.png", PNG);
    const newest = await images.importBytes("new.png", PNG);
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "Look at both", [oldest.id, newest.id]);
    vi.mocked(adapterFor).mockReturnValue({
      protocol: "openai-chat",
      listModels: async () => [],
      async *stream() {
        yield { type: "block", index: 1, blockType: "text", content: "An older screenshot.", complete: true } as const;
        yield { type: "complete", stopReason: "stop" } as const;
      }
    });

    const prepared = await new VisionService(store, images).prepare(
      store.getGenerationRecord(created.generationId)!, main, new AbortController().signal,
      () => undefined
    );

    expect(prepared.get(oldest.id)?.description).toBe("An older screenshot.");
    expect(prepared.get(oldest.id)?.image).toBeUndefined();
    expect(prepared.get(newest.id)?.image).toMatchObject({ fileName: "new.png" });
    expect(adapterFor).toHaveBeenCalledTimes(1);
    store.close();
  });
});
