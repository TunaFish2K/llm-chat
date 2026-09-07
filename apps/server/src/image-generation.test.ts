import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationManager } from "./image-generation";
import { EventHub } from "./events";
import { ImageService } from "./images";
import { cleanupStores, createStore } from "./test-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupStores();
});

describe("ImageGenerationManager", () => {
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
