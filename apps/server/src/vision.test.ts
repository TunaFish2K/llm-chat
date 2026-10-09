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
      name: "Vision", baseUrl: "https://vision.test/v1", apiKey: "key", secretHeaders: {}
    });
    const vision = store.createModel({
      connectionId: connection.id,
      modelKey: "vision-model",
      protocol: "openai-responses",
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
    expect(adapterFor).toHaveBeenCalledWith("openai-responses");
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
      name: "Vision", baseUrl: "https://vision.test/v1", apiKey: "key", secretHeaders: {}
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

describe("provider-sized images", () => {
  async function bigPng(width: number, height: number, alpha = false): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    // Noise does not compress, so the PNG is large enough to need conversion.
    const channels = alpha ? 4 : 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) >>> 24;
    return sharp(raw, { raw: { width, height, channels } }).png({ compressionLevel: 0 }).toBuffer();
  }

  it("resizes oversized images per protocol, caches them, and reads each image once per generation", async () => {
    const sharp = (await import("sharp")).default;
    const store = createStore();
    const seeded = seedModel(store);
    const main = store.updateModel(seeded.model.id, { capabilities: { ...seeded.model.capabilities, imageInput: true } })!;
    const images = new ImageService(store);
    await images.initialize();
    const asset = await images.importBytes("photo.png", await bigPng(3000, 1500));
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "Look", [asset.id]);
    const record = store.getGenerationRecord(created.generationId)!;
    const service = new VisionService(store, images);
    const read = vi.spyOn(images, "readAsset");
    const reuse = new Map();

    const first = await service.prepare(record, main, new AbortController().signal, () => undefined, reuse);
    const sent = first.get(asset.id)!.image!;
    expect(sent.mimeType).toBe("image/jpeg");
    const metadata = await sharp(Buffer.from(sent.dataBase64, "base64")).metadata();
    expect(Math.max(metadata.width!, metadata.height!)).toBe(2048);
    await service.prepare(record, main, new AbortController().signal, () => undefined, reuse);
    expect(read).toHaveBeenCalledTimes(1);

    const anthropic = await service.prepare({ ...record, protocol: "anthropic-messages" }, main, new AbortController().signal, () => undefined);
    const small = await sharp(Buffer.from(anthropic.get(asset.id)!.image!.dataBase64, "base64")).metadata();
    expect(Math.max(small.width!, small.height!)).toBeLessThanOrEqual(1568);
    // A second service finds the cached copy on disk instead of converting again.
    const again = await new VisionService(store, images).prepare(record, main, new AbortController().signal, () => undefined);
    expect(again.get(asset.id)!.image!.dataBase64).toBe(sent.dataBase64);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps transparency and falls back to descriptions when the request budget is spent", async () => {
    const { convert, imageProfile } = await import("./image-derivatives");
    const transparent = await convert(await bigPng(2400, 600, true), "image/png", imageProfile("openai-chat"));
    expect(transparent.mimeType).toBe("image/webp");
    const tiny = { id: "tiny", maxEdge: 64, maxBytes: 200, requestBytes: 1 };
    await expect(convert(await bigPng(512, 512), "image/png", tiny)).rejects.toThrow("compressed");
    await expect(convert(Buffer.alloc(300), "image/png", tiny)).rejects.toThrow();
    expect((await convert(Buffer.from(PNG), "image/png", tiny)).bytes).toEqual(Buffer.from(PNG));

    const store = createStore();
    const seeded = seedModel(store);
    const main = store.updateModel(seeded.model.id, { capabilities: { ...seeded.model.capabilities, imageInput: true } })!;
    const images = new ImageService(store);
    await images.initialize();
    const assets = [await images.importBytes("a.png", await bigPng(900, 900)), await images.importBytes("b.png", await bigPng(901, 900))];
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "Look", assets.map((asset) => asset.id));
    const derived = await import("./image-derivatives");
    vi.spyOn(derived, "imageProfile").mockReturnValue({ id: "budget-test", maxEdge: 2048, maxBytes: 8 * 1024 ** 2, requestBytes: assets[1]!.byteSize + 10 });
    await expect(new VisionService(store, images).prepare(store.getGenerationRecord(created.generationId)!, main, new AbortController().signal, () => undefined))
      .rejects.toThrow("单次请求");
  });
});
