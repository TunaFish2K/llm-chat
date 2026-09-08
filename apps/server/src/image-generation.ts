import type { ImageGenerationInput, ImageGenerationJobDto, ImageGenerationJobStatus } from "@llm-chat/contracts";
import {
  imageAdapter,
  ProviderError,
  type ImageGenerationCompleted,
  type ImageGenerationRequest,
  type ProviderConnection,
  type ProviderImage
} from "@llm-chat/providers";
import { Store, StoreError } from "./database";
import { EventHub } from "./events";
import { ImageService } from "./images";
import { ServiceSettings } from "./service-settings";

type CreateImageGenerationInput = {
  conversationId: string;
  input: ImageGenerationInput;
  toolCallId?: string;
};

export class ImageGenerationManager {
  private readonly runs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;

  constructor(
    private readonly store: Store,
    private readonly images: ImageService,
    private readonly events: EventHub
  ) {}

  async initialize(): Promise<void> {
    for (const job of this.store.listImageGenerationJobs()) {
      if (isTerminal(job.status)) continue;
      this.start(job.id);
    }
  }

  create(input: CreateImageGenerationInput): ImageGenerationJobDto {
    const conversation = this.store.getConversation(input.conversationId);
    if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
    const model = this.store.getModel(input.input.modelId);
    if (!model?.enabled) throw new StoreError("image_model_not_found", "图片模型不存在或已停用");
    if (!model.capabilities.imageOutput || !model.imageProtocol) {
      throw new StoreError("image_model_unsupported", "所选模型不支持图片生成");
    }
    if (!new ServiceSettings(this.store).images().some((item) => item.modelId === model.id && item.available)) {
      throw new StoreError("image_model_disabled", "此图片模型未在全局图片工具设置中启用");
    }
    const connection = this.store.getConnection(model.connectionId);
    if (!connection) throw new StoreError("connection_not_found", "模型连接不存在");
    this.assertInputsBelongToConversation(input.conversationId, input.input);
    const assistantMessageId = this.store.createImageAssistantMessage(input.conversationId);
    return this.store.createImageGenerationJob({
      conversationId: input.conversationId,
      assistantMessageId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      model,
      connection,
      request: input.input
    });
  }

  start(jobId: string): void {
    if (this.closing || this.runs.has(jobId)) return;
    const job = this.store.getImageGenerationJob(jobId);
    if (!job || isTerminal(job.status)) return;
    const promise = this.run(jobId).finally(() => {
      this.runs.delete(jobId);
      this.controllers.delete(jobId);
    });
    this.runs.set(jobId, promise);
  }

  async createAndWait(input: CreateImageGenerationInput, signal?: AbortSignal): Promise<ImageGenerationJobDto> {
    const job = this.create(input);
    this.start(job.id);
    return this.wait(job.id, signal);
  }

  hasActiveForConversation(conversationId: string): boolean {
    return this.store.listImageGenerationJobs(conversationId).some((job) => !isTerminal(job.status));
  }

  async wait(jobId: string, signal?: AbortSignal): Promise<ImageGenerationJobDto> {
    while (true) {
      signal?.throwIfAborted();
      const job = this.store.getImageGenerationJob(jobId);
      if (!job) throw new StoreError("image_generation_not_found", "图片生成任务不存在");
      if (isTerminal(job.status)) return job;
      await delay(250, signal);
    }
  }

  cancel(jobId: string): ImageGenerationJobDto {
    const job = this.store.getImageGenerationJob(jobId);
    if (!job) throw new StoreError("image_generation_not_found", "图片生成任务不存在");
    if (!isTerminal(job.status)) {
      this.controllers.get(jobId)?.abort(new Error("图片生成已取消"));
      const updated = this.store.updateImageGenerationJob(jobId, {
        status: "cancelled",
        error: { code: "image_generation_cancelled", message: "图片生成已取消" },
        completedAt: Date.now()
      });
      if (updated) this.emit(updated);
    }
    return this.store.getImageGenerationJob(jobId)!;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort(new Error("图片生成管理器已关闭"));
    await Promise.allSettled([...this.runs.values()]);
  }

  private async run(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    const job = this.store.getImageGenerationJob(jobId);
    if (!job) return;
    try {
      const input = this.store.getImageGenerationInput(jobId);
      const model = this.store.getModel(job.modelId);
      const connection = model ? this.store.getConnection(model.connectionId) : undefined;
      if (!input || !model?.enabled || !connection || model.imageProtocol !== job.imageProtocol) {
        throw new StoreError("image_generation_config_invalid", "图片生成任务的模型配置已失效");
      }
      this.assertInputsBelongToConversation(job.conversationId, input);
      const request = await this.requestFor(job, input, connection, controller.signal);
      controller.signal.throwIfAborted();
      const adapter = imageAdapter(job.imageProtocol);
      this.update(jobId, { status: "running", progress: 0.05, startedAt: job.startedAt ?? Date.now() });

      let completed: ImageGenerationCompleted;
      if (job.providerJobId && adapter.poll) {
        completed = await this.poll(adapter, request, jobId, job.providerJobId);
      } else {
        const result = await adapter.start(request);
        if (result.status === "pending") {
          if (!adapter.poll) throw new ProviderError("image_async_unsupported", "图片服务返回了异步任务，但未提供轮询接口");
          this.update(jobId, { status: "waiting-provider", progress: 0.1, providerJobId: result.providerJobId });
          completed = await this.poll(adapter, request, jobId, result.providerJobId, result.pollAfterMs);
        } else {
          completed = result;
        }
      }
      await this.complete(jobId, completed);
    } catch (error) {
      const current = this.store.getImageGenerationJob(jobId);
      if (current?.status === "cancelled") return;
      if (controller.signal.aborted && this.closing) return;
      const providerError = error instanceof ProviderError ? error : undefined;
      const code = providerError?.code ?? (error instanceof StoreError ? error.code : "image_generation_failed");
      const message = error instanceof Error ? error.message : "图片生成失败";
      const failed = this.update(jobId, {
        status: "failed",
        error: { code, message },
        completedAt: Date.now()
      });
      if (failed) this.emit(failed);
    }
  }

  private async requestFor(
    job: ImageGenerationJobDto,
    input: ImageGenerationInput,
    connection: ProviderConnection,
    signal: AbortSignal
  ): Promise<ImageGenerationRequest> {
    const referenceImages: ProviderImage[] = [];
    for (const assetId of input.referenceAssetIds) {
      const loaded = await this.images.readAsset(assetId);
      referenceImages.push({
        mimeType: loaded.asset.mimeType,
        dataBase64: Buffer.from(loaded.bytes).toString("base64"),
        fileName: loaded.asset.fileName
      });
    }
    let mask: ProviderImage | undefined;
    if (input.maskAssetId) {
      const loaded = await this.images.readAsset(input.maskAssetId);
      mask = {
        mimeType: loaded.asset.mimeType,
        dataBase64: Buffer.from(loaded.bytes).toString("base64"),
        fileName: loaded.asset.fileName
      };
    }
    const {
      modelId: _modelId,
      prompt: _prompt,
      operation: _operation,
      referenceAssetIds: _referenceAssetIds,
      maskAssetId: _maskAssetId,
      ...options
    } = input;
    return {
      connection,
      modelKey: job.modelKey,
      protocol: job.imageProtocol,
      operation: input.operation,
      prompt: input.prompt,
      referenceImages,
      ...(mask ? { mask } : {}),
      options,
      signal
    };
  }

  private async poll(
    adapter: ReturnType<typeof imageAdapter>,
    request: ImageGenerationRequest,
    jobId: string,
    providerJobId: string,
    firstDelayMs = 2_000
  ): Promise<ImageGenerationCompleted> {
    let waitMs = firstDelayMs;
    while (true) {
      await delay(waitMs, request.signal);
      const result = await adapter.poll!(request, providerJobId);
      if (result.status === "completed" && result.result) return result.result;
      if (result.status === "failed") throw new ProviderError("image_provider_job_failed", result.error ?? "图片服务异步任务失败");
      this.update(jobId, { status: "waiting-provider", progress: null, providerJobId });
      waitMs = result.pollAfterMs ?? 2_000;
    }
  }

  private async complete(jobId: string, result: ImageGenerationCompleted): Promise<void> {
    if (!result.images.length) throw new ProviderError("image_response_invalid", "图片服务没有返回图片");
    const job = this.store.getImageGenerationJob(jobId);
    if (!job || isTerminal(job.status)) return;
    const assets = [];
    for (const [index, image] of result.images.slice(0, 4).entries()) {
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
      const bytes = image.data
        ?? (image.url
          ? (await this.images.fetchPublicFile(
            image.url,
            32 * 1024 * 1024,
            this.controllers.get(jobId)?.signal
          )).bytes
          : null);
      if (!bytes) throw new ProviderError("image_response_invalid", "图片结果缺少数据或 URL");
      assets.push(await this.images.importGeneratedBytes(`${job.modelKey}-${index + 1}.${extension}`, bytes));
      this.controllers.get(jobId)?.signal.throwIfAborted();
    }
    const updated = this.store.attachImageJobOutputs(jobId, assets.map((asset) => asset.id));
    if (!updated) return;
    for (const asset of assets) if (updated.toolCallId) this.store.attachImageToToolCall(updated.toolCallId, asset.id);
    const completed = this.update(jobId, {
      status: "completed",
      progress: 1,
      outputAssetIds: assets.map((asset) => asset.id),
      revisedPrompt: result.revisedPrompt ?? result.images.find((image) => image.revisedPrompt)?.revisedPrompt ?? null,
      completedAt: Date.now()
    });
    if (completed) this.emit(completed);
  }

  private update(jobId: string, patch: Parameters<Store["updateImageGenerationJob"]>[1]): ImageGenerationJobDto | undefined {
    const current = this.store.getImageGenerationJob(jobId);
    if (!current || isTerminal(current.status)) return undefined;
    const updated = this.store.updateImageGenerationJob(jobId, patch);
    if (updated) this.emit(updated);
    return updated;
  }

  private emit(job: ImageGenerationJobDto): void {
    this.events.emit({ type: "image-generation", jobId: job.id, conversationId: job.conversationId, job });
  }

  private assertInputsBelongToConversation(conversationId: string, input: ImageGenerationInput): void {
    for (const assetId of [...input.referenceAssetIds, ...(input.maskAssetId ? [input.maskAssetId] : [])]) {
      if (!this.store.getImageAsset(assetId) || !this.store.imageAssetBelongsToConversation(conversationId, assetId)) {
        throw new StoreError("image_asset_not_allowed", "引用图片不属于当前会话");
      }
    }
  }
}

function isTerminal(status: ImageGenerationJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("操作已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("操作已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
