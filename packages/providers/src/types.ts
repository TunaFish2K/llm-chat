import type {
  BlockType,
  GenerationSettings,
  ModelCapabilities,
  ProviderProtocol,
  UsageDto
} from "@llm-chat/contracts";

export interface ProviderConnection {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  secretHeaders: Record<string, string>;
}

export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  images?: ProviderImage[];
  toolCalls?: ProviderToolCall[];
  toolResults?: ProviderToolResult[];
  providerPayload?: unknown;
  providerConnectionId?: string;
}

export interface ProviderImage {
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
   * resolved `settings.reasoningEffort` (top-level); adapters must
   * consult that field only, and must also honour `capabilities` to
   * decide whether a thinking/reasoning knob is actually safe to emit.
   */
  settings: GenerationSettings;
  capabilities: ModelCapabilities;
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
  | { type: "tool-call"; call: ProviderToolCall }
  | { type: "usage"; usage: UsageDto }
  | { type: "complete"; stopReason: string };

export interface DiscoveredModel {
  id: string;
  displayName: string;
}

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  listModels(connection: ProviderConnection, signal?: AbortSignal): Promise<DiscoveredModel[]>;
  stream(request: GenerateRequest): AsyncGenerator<ProviderEvent>;
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
