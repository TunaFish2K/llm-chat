import { withMessage } from "@llm-chat/i18n";
import type { ImageProviderProtocol } from "@llm-chat/contracts";
import { ProviderError, type GeneratedImage, type ImageGenerationAdapter, type ImageGenerationCompleted, type ImageGenerationPollResult, type ImageGenerationRequest, type ImageGenerationStart } from "./types";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export class OpenAiImageAdapter implements ImageGenerationAdapter {
  readonly protocol = "openai-images" as const;

  async start(request: ImageGenerationRequest): Promise<ImageGenerationStart> {
    if (request.operation === "generate") return this.jsonRequest(request, "images/generations");
    if (request.operation === "variation") return this.multipartRequest(request, "images/variations");
    return this.multipartRequest(request, "images/edits");
  }

  private async jsonRequest(request: ImageGenerationRequest, resource: string): Promise<ImageGenerationStart> {
    const body: Record<string, unknown> = {
      model: request.modelKey,
      prompt: request.prompt,
      n: request.options.count ?? 1,
      response_format: "b64_json",
      ...(request.options.size ? { size: request.options.size } : {}),
      ...(request.options.quality ? { quality: request.options.quality } : {}),
      ...(request.options.outputFormat ? { output_format: request.options.outputFormat } : {}),
      ...(request.options.providerOptions ?? {})
    };
    return parseOpenAiResponse(await fetchJson(request, resource, body));
  }

  private async multipartRequest(request: ImageGenerationRequest, resource: string): Promise<ImageGenerationStart> {
    const form = new FormData();
    form.append("model", request.modelKey);
    form.append("prompt", request.prompt);
    if (request.options.count !== undefined) form.append("n", String(request.options.count));
    if (request.options.size) form.append("size", request.options.size);
    if (request.options.quality) form.append("quality", request.options.quality);
    if (request.options.outputFormat) form.append("output_format", request.options.outputFormat);
    if (request.options.providerOptions) appendFormOptions(form, request.options.providerOptions);
    if (request.operation === "variation") {
      const image = request.referenceImages[0];
      if (!image) throw withMessage(new ProviderError("image_input_required", "图片变体需要一张参考图片"), "error.image_variations_require_a_reference_image");
      form.append("image", blobFor(image), image.fileName ?? "reference.png");
    } else {
      for (const [index, image] of request.referenceImages.entries()) {
        form.append("image[]", blobFor(image), image.fileName ?? `reference-${index + 1}.png`);
      }
      if (request.mask) form.append("mask", blobFor(request.mask), request.mask.fileName ?? "mask.png");
    }
    return parseOpenAiResponse(await fetchMultipart(request, resource, form));
  }
}

export class GoogleImagenAdapter implements ImageGenerationAdapter {
  readonly protocol = "google-imagen" as const;

  async start(request: ImageGenerationRequest): Promise<ImageGenerationStart> {
    if (request.operation !== "generate") throw withMessage(new ProviderError("image_operation_unsupported", "Imagen 仅支持文本生图"), "error.imagen_supports_text_to_image_generation_only");
    const root = googleRoot(request.connection.baseUrl);
    const url = `${root}/models/${encodeURIComponent(request.modelKey)}:predict`;
    const parameters = {
      sampleCount: request.options.count ?? 1,
      ...(request.options.aspectRatio ? { aspectRatio: request.options.aspectRatio } : {}),
      ...(request.options.size ? { imageSize: request.options.size } : {}),
      ...(request.options.providerOptions ?? {})
    };
    const response = await fetch(url, {
      method: "POST",
      headers: googleHeaders(request),
      body: JSON.stringify({ instances: [{ prompt: request.prompt }], parameters }),
      signal: request.signal
    });
    return parseGoogleImagen(await responsePayload(response));
  }
}

export class GoogleInteractionsAdapter implements ImageGenerationAdapter {
  readonly protocol = "google-interactions" as const;

  async start(request: ImageGenerationRequest): Promise<ImageGenerationStart> {
    const root = googleRoot(request.connection.baseUrl);
    const input: Array<Record<string, string>> = [{ type: "text", text: request.prompt }];
    for (const image of request.referenceImages) {
      input.push({ type: "image", mime_type: image.mimeType, data: image.dataBase64 });
    }
    const responseFormat: Record<string, unknown> = {
      type: "image",
      ...(request.options.aspectRatio ? { aspect_ratio: request.options.aspectRatio } : {}),
      ...(request.options.size ? { image_size: request.options.size } : {}),
      ...(request.options.outputFormat ? { mime_type: `image/${request.options.outputFormat}` } : {})
    };
    const response = await fetch(`${root}/interactions`, {
      method: "POST",
      headers: googleHeaders(request),
      body: JSON.stringify({
        model: request.modelKey,
        input,
        response_format: responseFormat,
        ...(request.options.providerOptions ?? {})
      }),
      signal: request.signal
    });
    return parseGoogleInteraction(await responsePayload(response));
  }
}

export class StabilityImageAdapter implements ImageGenerationAdapter {
  readonly protocol = "stability-image" as const;

  async start(request: ImageGenerationRequest): Promise<ImageGenerationStart> {
    if (request.operation === "variation" && !request.referenceImages.length) {
      throw withMessage(new ProviderError("image_input_required", "图片变体需要一张参考图片"), "error.image_variations_require_a_reference_image");
    }
    const form = new FormData();
    form.append("prompt", request.prompt);
    if (request.options.negativePrompt) form.append("negative_prompt", request.options.negativePrompt);
    if (request.options.seed !== undefined) form.append("seed", String(request.options.seed));
    if (request.options.outputFormat) form.append("output_format", request.options.outputFormat);
    if (request.options.aspectRatio) form.append("aspect_ratio", request.options.aspectRatio);
    if (request.options.providerOptions) appendFormOptions(form, request.options.providerOptions);
    const reference = request.referenceImages[0];
    if (reference) form.append("image", blobFor(reference), reference.fileName ?? "reference.png");
    if (request.mask) form.append("mask", blobFor(request.mask), request.mask.fileName ?? "mask.png");
    const resource = request.operation === "generate"
      ? `stable-image/generate/${encodeURIComponent(request.modelKey)}`
      : "stable-image/edit/inpaint";
    const response = await fetch(`${stabilityRoot(request.connection.baseUrl)}/${resource}`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.connection.apiKey}`, accept: "application/json", ...request.connection.secretHeaders },
      body: form,
      signal: request.signal
    });
    const payload = await responsePayload(response);
    if (payload instanceof Uint8Array) return { status: "completed", images: [{ data: payload, mimeType: "image/png" }] };
    const record = asRecord(payload);
    const images = collectImages(record);
    if (images.length) return { status: "completed", images };
    if (typeof record.id === "string") return { status: "pending", providerJobId: record.id, pollAfterMs: 2_000 };
    throw withMessage(new ProviderError("image_response_invalid", "Stability 返回中没有图片结果"), "error.stability_returned_no_images");
  }

  async poll(request: ImageGenerationRequest, providerJobId: string): Promise<ImageGenerationPollResult> {
    const response = await fetch(`${stabilityRoot(request.connection.baseUrl)}/stable-image/results/${encodeURIComponent(providerJobId)}`, {
      headers: { authorization: `Bearer ${request.connection.apiKey}`, accept: "application/json", ...request.connection.secretHeaders },
      signal: request.signal
    });
    if (response.status === 202) return { status: "pending", providerJobId, pollAfterMs: 2_000 };
    const payload = await responsePayload(response);
    const record = asRecord(payload);
    const images = collectImages(record);
    if (images.length) return { status: "completed", providerJobId, result: { status: "completed", images } };
    if (typeof record.error === "string") return { status: "failed", providerJobId, error: record.error };
    return { status: "pending", providerJobId, pollAfterMs: 2_000 };
  }
}

export function imageAdapterFor(protocol: ImageProviderProtocol): ImageGenerationAdapter {
  if (protocol === "openai-images") return new OpenAiImageAdapter();
  if (protocol === "google-imagen") return new GoogleImagenAdapter();
  if (protocol === "google-interactions") return new GoogleInteractionsAdapter();
  return new StabilityImageAdapter();
}

async function fetchJson(request: ImageGenerationRequest, resource: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(joinUrl(request.connection.baseUrl, resource), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.connection.apiKey}`, ...request.connection.secretHeaders },
    body: JSON.stringify(body), signal: request.signal
  });
  return responsePayload(response);
}

async function fetchMultipart(request: ImageGenerationRequest, resource: string, body: FormData): Promise<unknown> {
  const response = await fetch(joinUrl(request.connection.baseUrl, resource), {
    method: "POST",
    headers: { authorization: `Bearer ${request.connection.apiKey}`, ...request.connection.secretHeaders },
    body, signal: request.signal
  });
  return responsePayload(response);
}

async function responsePayload(response: Response): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError("image_provider_error", text.slice(0, 2_000) || `图片服务返回 HTTP ${response.status}`, response.status);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) return new Uint8Array(await response.arrayBuffer());
  try { return await response.json(); } catch { throw withMessage(new ProviderError("image_response_invalid", "图片服务返回了无法解析的响应"), "error.the_image_service_returned_an_unreadable_response"); }
}

function parseOpenAiResponse(payload: unknown): ImageGenerationCompleted {
  const data = asRecord(payload).data;
  if (!Array.isArray(data)) throw withMessage(new ProviderError("image_response_invalid", "OpenAI 图片响应缺少 data"), "error.the_openai_image_response_is_missing_data");
  const images = data.map((item) => {
    const record = asRecord(item);
    const encoded = typeof record.b64_json === "string" ? record.b64_json : null;
    if (encoded) {
      return { data: Uint8Array.from(Buffer.from(encoded, "base64")), mimeType: "image/png" as const, ...(typeof record.revised_prompt === "string" ? { revisedPrompt: record.revised_prompt } : {}) };
    }
    if (typeof record.url === "string" && /^https?:\/\//i.test(record.url)) {
      return { url: record.url, mimeType: "image/png" as const, ...(typeof record.revised_prompt === "string" ? { revisedPrompt: record.revised_prompt } : {}) };
    }
    throw withMessage(new ProviderError("image_response_invalid", "OpenAI 图片响应缺少图片数据"), "error.the_openai_image_response_is_missing_image_data");
  });
  return { status: "completed", images, ...(typeof asRecord(data[0]).revised_prompt === "string" ? { revisedPrompt: String(asRecord(data[0]).revised_prompt) } : {}) };
}

function parseGoogleImagen(payload: unknown): ImageGenerationCompleted {
  const predictions = asRecord(payload).predictions;
  if (!Array.isArray(predictions)) throw withMessage(new ProviderError("image_response_invalid", "Imagen 响应缺少 predictions"), "error.the_imagen_response_is_missing_predictions");
  const images = predictions.map((item) => {
    const record = asRecord(item);
    const encoded = typeof record.bytesBase64Encoded === "string" ? record.bytesBase64Encoded : typeof record.imageBytes === "string" ? record.imageBytes : null;
    if (!encoded) throw withMessage(new ProviderError("image_response_invalid", "Imagen 响应缺少图片数据"), "error.the_imagen_response_is_missing_image_data");
    return { data: Uint8Array.from(Buffer.from(encoded, "base64")), mimeType: normalizeMime(record.mimeType) };
  });
  return { status: "completed", images };
}

function parseGoogleInteraction(payload: unknown): ImageGenerationCompleted {
  const images = collectImages(asRecord(payload));
  if (!images.length) throw withMessage(new ProviderError("image_response_invalid", "Gemini 图片响应缺少图片数据"), "error.the_gemini_image_response_is_missing_image_data");
  return { status: "completed", images };
}

function collectImages(value: Record<string, unknown>): GeneratedImage[] {
  const found: GeneratedImage[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string" && item.length > 100) {
      if (/^[A-Za-z0-9+/]+=*$/.test(item)) found.push({ data: Uint8Array.from(Buffer.from(item, "base64")), mimeType: "image/png" });
      return;
    }
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    const record = item as Record<string, unknown>;
    for (const key of ["data", "imageBytes", "bytesBase64Encoded", "b64_json"]) {
      const encoded = record[key];
      if (typeof encoded === "string" && encoded.length > 100) {
        found.push({ data: Uint8Array.from(Buffer.from(encoded, "base64")), mimeType: normalizeMime(record.mimeType) });
        return;
      }
    }
    for (const key of ["url", "imageUrl"]) {
      const url = record[key];
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        found.push({ url, mimeType: normalizeMime(record.mimeType) });
        return;
      }
    }
    const imageUrl = asRecord(record.image_url).url;
    if (typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl)) {
      found.push({ url: imageUrl, mimeType: normalizeMime(record.mimeType) });
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return found.filter((image, index, all) => all.findIndex((other) => {
    if (image.url || other.url) return image.url === other.url;
    return Boolean(image.data && other.data && Buffer.from(other.data).equals(Buffer.from(image.data)));
  }) === index);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeMime(value: unknown): GeneratedImage["mimeType"] {
  return typeof value === "string" && IMAGE_TYPES.has(value) ? value as GeneratedImage["mimeType"] : "image/png";
}

function blobFor(image: { dataBase64: string; mimeType: string }): Blob {
  return new Blob([Buffer.from(image.dataBase64, "base64")], { type: image.mimeType });
}

function appendFormOptions(form: FormData, options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function joinUrl(baseUrl: string, resource: string): string {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${resource.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  return base.toString();
}

function googleRoot(baseUrl: string): string {
  return baseUrl.replace(/\/openai\/?$/, "").replace(/\/$/, "");
}

function googleHeaders(request: ImageGenerationRequest): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": request.connection.apiKey, ...request.connection.secretHeaders };
}

function stabilityRoot(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}
