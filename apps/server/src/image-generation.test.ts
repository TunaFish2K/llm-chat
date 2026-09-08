import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationManager } from "./image-generation";
import { EventHub } from "./events";
import { ImageService } from "./images";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { ServiceSettings } from "./service-settings";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupStores();
});

describe("ImageGenerationManager", () => {
  it("does not attach late provider output after cancellation and enforces global disablement", async () => {
    const store = createStore(); const { model } = seedModel(store);
    store.updateModel(model.id, { capabilities: { ...model.capabilities, imageOutput: true }, imageProtocol: "openai-images" });
    const conversation = store.createConversation({ systemPrompt: "" });
    const images = new ImageService(store); await images.initialize();
    const manager = new ImageGenerationManager(store, images, new EventHub());
    const input = { conversationId: conversation.id, input: { modelId: model.id, prompt: "coast", operation: "generate" as const, referenceAssetIds: [], count: 1 } };
    const services = new ServiceSettings(store);
    services.update({ imageModels: [{ modelId: model.id, enabled: false }] });
    expect(() => manager.create(input)).toThrow("未在全局图片工具设置中启用");
    expect(store.listMessages(conversation.id)).toEqual([]);
    services.update({ imageModels: [{ modelId: model.id, enabled: true }] });
    let release!: (value: Awaited<ReturnType<ImageService["importGeneratedBytes"]>>) => void;
    const imported = vi.spyOn(images, "importGeneratedBytes").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ b64_json: "aW1hZ2U=" }] })));
    const job = manager.create(input); manager.start(job.id);
    await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
    manager.cancel(job.id);
    const asset = store.createFileAsset({ sha256: "c".repeat(64), fileName: "late.png", mimeType: "image/png", kind: "image", byteSize: 5, storageKey: "late" });
    release(asset as Awaited<ReturnType<ImageService["importGeneratedBytes"]>>);
    await manager.close();
    expect(store.getImageGenerationJob(job.id)).toMatchObject({ status: "cancelled", outputAssets: [] });
    expect(store.listMessages(conversation.id).at(-1)?.attachments).toEqual([]);
  });

  it("persists provider output as an assistant attachment and emits terminal state", async () => {
    const store = createStore();
    const connection = store.createConnection({
      name: "OpenAI images",
      providerId: "openai",
      protocol: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      secretHeaders: {}
    });
    const model = store.createModel({
      connectionId: connection.id,
      modelKey: "gpt-image-1",
      displayName: "GPT Image",
      contextWindow: null,
      maxOutputTokens: 4096,
      imageProtocol: "openai-images",
      capabilities: {
        imageInput: false,
        imageOutput: true,
        imageMultiple: true,
        tools: false,
        temperature: false,
        topP: false,
        reasoning: false,
        reasoningSummary: false,
        adaptiveThinking: false,
        manualThinking: false
      },
      defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} },
      enabled: true
    });
    const conversation = store.createConversation({ systemPrompt: "" });
    store.updateConversation(conversation.id, { modelId: model.id });
    const images = new ImageService(store);
    await images.initialize();
    const events: string[] = [];
    const hub = new EventHub();
    hub.subscribe(0, (event) => {
      if (event.type === "image-generation") events.push(event.job.status);
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] })));
    const manager = new ImageGenerationManager(store, images, hub);
    const job = manager.create({
      conversationId: conversation.id,
      input: {
        modelId: model.id,
        prompt: "a small red cabin",
        operation: "generate",
        referenceAssetIds: [],
        count: 1
      }
    });
    manager.start(job.id);
    const completed = await manager.wait(job.id);

    expect(completed.status).toBe("completed");
    expect(completed.outputAssets).toHaveLength(1);
    expect(store.listMessages(conversation.id).at(-1)?.attachments).toHaveLength(1);
    expect(events).toContain("completed");
    await manager.close();
  });
});
