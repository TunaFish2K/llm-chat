import { afterEach, describe, expect, it, vi } from "vitest";
import * as providers from "@llm-chat/providers";
import type { ImageGenerationAdapter, ImageGenerationCompleted } from "@llm-chat/providers";
import { ImageGenerationManager } from "./image-generation";
import { EventHub } from "./events";
import { ImageService } from "./images";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { ServiceSettings } from "./service-settings";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

const png = Buffer.from("iVBORw0KGgo=", "base64");
const output: ImageGenerationCompleted = { status: "completed", images: [{ data: png, mimeType: "image/png" }] };
async function imageFixture(protocol: "openai-images" | "stability-image" = "openai-images") {
  const store = createStore(); const { model } = seedModel(store);
  store.updateModel(model.id, { capabilities: { ...model.capabilities, imageOutput: true }, imageProtocol: protocol });
  const conversation = store.createConversation({ systemPrompt: "" });
  const images = new ImageService(store); await images.initialize();
  const manager = new ImageGenerationManager(store, images, new EventHub());
  const input = { conversationId: conversation.id, input: { modelId: model.id, prompt: "coast", operation: "generate" as const, referenceAssetIds: [] as string[], count: 1 } };
  return { store, model, conversation, images, manager, input };
}
function adapter(mock: Partial<ImageGenerationAdapter> = {}) {
  const value: ImageGenerationAdapter = { protocol: "openai-images", start: vi.fn(async () => output), ...mock };
  vi.spyOn(providers, "imageAdapter").mockReturnValue(value);
  return value;
}

it("validates conversation, model and reference ownership before creating a job", async () => {
  const f = await imageFixture();
  expect(() => f.manager.create({ ...f.input, conversationId: "missing" })).toThrow("会话不存在");
  expect(() => f.manager.create({ ...f.input, input: { ...f.input.input, modelId: "missing" } })).toThrow("模型不存在");
  f.store.updateModel(f.model.id, { enabled: false }); expect(() => f.manager.create(f.input)).toThrow("已停用");
  f.store.updateModel(f.model.id, { enabled: true, imageProtocol: null }); expect(() => f.manager.create(f.input)).toThrow("不支持图片生成");
  f.store.updateModel(f.model.id, { imageProtocol: "openai-images" });
  const image = await f.images.importBytes("private.png", png);
  expect(() => f.manager.create({ ...f.input, input: { ...f.input.input, referenceAssetIds: [image.id] } })).toThrow("不属于当前会话");
  expect(() => f.manager.create({ ...f.input, input: { ...f.input.input, maskAssetId: "missing" } })).toThrow("不属于当前会话");
  expect(f.store.listImageGenerationJobs()).toEqual([]);
  await expect(f.manager.wait("missing")).rejects.toThrow("不存在"); expect(() => f.manager.cancel("missing")).toThrow("不存在");
  f.manager.start("missing"); await f.manager.close();
});

it("loads owned references and masks, downloads URL output and caps attachment count", async () => {
  const f = await imageFixture(); const image = await f.images.importBytes("input.png", png);
  f.store.attachImagesToMessage(f.store.createImageAssistantMessage(f.conversation.id), [image.id]);
  const fetchFile = vi.spyOn(f.images, "fetchPublicFile").mockResolvedValue({ bytes: png, mimeType: "image/png", fileName: "result.png" });
  const provider = adapter({ start: vi.fn(async (): Promise<ImageGenerationCompleted> => ({ status: "completed", images: Array.from({ length: 5 }, () => ({ url: "https://images.example/result.png", mimeType: "image/jpeg", revisedPrompt: "better coast" })) })) });
  const job = await f.manager.createAndWait({ ...f.input, input: { ...f.input.input, operation: "edit", referenceAssetIds: [image.id], maskAssetId: image.id } });
  expect(job).toMatchObject({ status: "completed", revisedPrompt: "better coast" }); expect(job.outputAssets).toHaveLength(4);
  expect(provider.start).toHaveBeenCalledWith(expect.objectContaining({ operation: "edit", referenceImages: [expect.objectContaining({ fileName: "input.png", dataBase64: png.toString("base64") })], mask: expect.objectContaining({ fileName: "input.png" }) }));
  expect(fetchFile).toHaveBeenCalledTimes(4); expect(f.manager.hasActiveForConversation(f.conversation.id)).toBe(false);
  expect(f.manager.cancel(job.id).status).toBe("completed"); f.manager.start(job.id); await f.manager.close();
});

it.each([
  ["empty output", async () => ({ status: "completed", images: [] }), "image_response_invalid"],
  ["missing image data", async () => ({ status: "completed", images: [{ mimeType: "image/png" }] }), "image_response_invalid"],
  ["unpollable job", async () => ({ status: "pending", providerJobId: "remote" }), "image_async_unsupported"],
  ["provider error", async () => { throw new providers.ProviderError("rate_limit", "quota"); }, "rate_limit"],
  ["unexpected error", async () => { throw "unavailable"; }, "image_generation_failed"]
] as const)("records failure for %s without attaching output", async (_label, start, code) => {
  const f = await imageFixture(); adapter({ start: start as ImageGenerationAdapter["start"] });
  const job = await f.manager.createAndWait(f.input);
  expect(job).toMatchObject({ status: "failed", error: { code } }); expect(job.outputAssets).toEqual([]);
  expect(f.manager.hasActiveForConversation(f.conversation.id)).toBe(false); await f.manager.close();
});

it("fails queued jobs when their model configuration changes", async () => {
  const f = await imageFixture(); const job = f.manager.create(f.input);
  f.store.updateModel(f.model.id, { enabled: false }); f.manager.start(job.id);
  expect(await f.manager.wait(job.id)).toMatchObject({ status: "failed", error: { code: "image_generation_config_invalid" } });
  await f.manager.close();
});

it("polls queued work, persists intermediate progress and resumes a provider receipt", async () => {
  const f = await imageFixture("stability-image");
  const poll = vi.fn().mockResolvedValueOnce({ status: "pending", providerJobId: "receipt", pollAfterMs: 1 }).mockResolvedValue({ status: "completed", result: output });
  const provider = adapter({ start: vi.fn(async () => ({ status: "pending" as const, providerJobId: "receipt", pollAfterMs: 1 })), poll });
  const job = await f.manager.createAndWait(f.input); expect(job.status).toBe("completed"); expect(poll).toHaveBeenCalledTimes(2);
  const resumed = f.manager.create(f.input); f.store.updateImageGenerationJob(resumed.id, { status: "waiting-provider", providerJobId: "receipt" });
  await f.manager.initialize(); f.manager.start(resumed.id);
  await f.manager.wait(resumed.id); await f.manager.close();
  expect(f.store.getImageGenerationJob(resumed.id)?.status).toBe("completed"); expect(provider.start).toHaveBeenCalledTimes(1);
});

it.each(["provider rejected", undefined])("records asynchronous job failure: %s", async error => {
  const f = await imageFixture();
  adapter({ start: async () => ({ status: "pending", providerJobId: "receipt", pollAfterMs: 0 }), poll: async () => ({ status: "failed", providerJobId: "receipt", ...(error ? { error } : {}) }) });
  expect(await f.manager.createAndWait(f.input)).toMatchObject({ status: "failed", error: { code: "image_provider_job_failed" } });
  await f.manager.close();
});

it("abort cancels waiting and shutdown preserves the provider receipt for restart", async () => {
  const f = await imageFixture();
  adapter({ start: async () => ({ status: "pending", providerJobId: "receipt", pollAfterMs: 60_000 }), poll: vi.fn() });
  const job = f.manager.create(f.input); f.manager.start(job.id);
  await vi.waitFor(() => expect(f.store.getImageGenerationJob(job.id)?.status).toBe("waiting-provider"));
  const controller = new AbortController(); const waiting = f.manager.wait(job.id, controller.signal); controller.abort(new Error("caller stopped"));
  await expect(waiting).rejects.toThrow("caller stopped");
  await f.manager.close(); expect(f.store.getImageGenerationJob(job.id)).toMatchObject({ status: "waiting-provider", providerJobId: "receipt" });
  f.manager.start(job.id); expect(f.manager.hasActiveForConversation(f.conversation.id)).toBe(true);
  const next = new ImageGenerationManager(f.store, f.images, new EventHub());
  expect(next.cancel(job.id).status).toBe("cancelled"); await next.initialize(); await next.close();
});
