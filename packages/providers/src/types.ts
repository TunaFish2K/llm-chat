import type {
  BlockType,
  GenerationSettings,
  ModelCapabilities,
  ImageGenerationInput,
  ImageGenerationOperation,
  ImageProviderProtocol,
  ProviderPresetId,
  ProviderProtocol,
  UsageDto
} from "@llm-chat/contracts";

export interface ProviderConnection {
  id: string;
  providerId: ProviderPresetId;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  secretHeaders: Record<string, string>;
}

export interface ProviderRequestContext {
  sessionId: string;
  requestId: string;
  clientId: string;
  userAgent: string;
}

export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  images?: ProviderImage[];
  toolCalls?: ProviderToolCall[];
  toolResults?: ProviderToolResult[];
  providerPayload?: unknown;
  providerConnectionId?: string;
  providerProtocol?: ProviderProtocol;
  providerModelKey?: string;
}

export interface ProviderImage {
  assetId?: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  dataBase64: string;
  fileName?: string;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface GenerateRequest {
  connection: ProviderConnection;
  modelKey: string;
  systemPrompt: string;
  postHistoryInstructions?: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDefinition[];
  /**
   * Effective settings for this generation. The server has already
   * resolved `settings.reasoningSelection` for the current model.
   * Adapters use providerReasoningEffort, which also reads legacy
   * reasoningEffort snapshots, and honour the model capabilities.
   */
  settings: GenerationSettings;
  capabilities: ModelCapabilities;
  requestContext: ProviderRequestContext;
  signal: AbortSignal;
}

export type ProviderEvent =
  | {
      type: "block";
      index: number;
      blockType: BlockType;
      content: string;
      complete: boolean;
      providerPayload?: unknown;
    }
  | { type: "provider-context"; payload: unknown }
  | { type: "image"; dataBase64: string }
  | { type: "tool-call"; call: ProviderToolCall }
  | { type: "usage"; usage: UsageDto }
  | { type: "complete"; stopReason: string };

export interface DiscoveredModel {
  id: string;
  displayName: string;
}

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  listModels(connection: ProviderConnection, signal?: AbortSignal, requestContext?: ProviderRequestContext): Promise<DiscoveredModel[]>;
  stream(request: GenerateRequest): AsyncGenerator<ProviderEvent>;
}

export interface ImageGenerationRequest {
  connection: ProviderConnection;
  modelKey: string;
  protocol: ImageProviderProtocol;
  operation: ImageGenerationOperation;
  prompt: string;
  referenceImages: ProviderImage[];
  mask?: ProviderImage;
  options: Omit<ImageGenerationInput, "modelId" | "prompt" | "operation" | "referenceAssetIds" | "maskAssetId">;
  signal: AbortSignal;
}

export interface GeneratedImage {
  data?: Uint8Array;
  url?: string;
  mimeType: ProviderImage["mimeType"];
  revisedPrompt?: string;
}

export interface ImageGenerationCompleted {
  status: "completed";
  images: GeneratedImage[];
  revisedPrompt?: string;
}

export interface ImageGenerationPending {
  status: "pending";
  providerJobId: string;
  pollAfterMs?: number;
}

export type ImageGenerationStart = ImageGenerationCompleted | ImageGenerationPending;

export interface ImageGenerationPollResult {
  status: "pending" | "completed" | "failed";
  providerJobId: string;
  pollAfterMs?: number;
  result?: ImageGenerationCompleted;
  error?: string;
}

export interface ImageGenerationAdapter {
  readonly protocol: ImageProviderProtocol;
  start(request: ImageGenerationRequest): Promise<ImageGenerationStart>;
  poll?(request: ImageGenerationRequest, providerJobId: string): Promise<ImageGenerationPollResult>;
  cancel?(request: ImageGenerationRequest, providerJobId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
