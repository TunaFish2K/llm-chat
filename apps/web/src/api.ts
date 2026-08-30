import type {
  AppSettings,
  ConnectionDto,
  ConnectionInput,
  ContextPolicy,
  ConversationStartedDto,
  ConversationDto,
  GenerationCreatedDto,
  GenerationDto,
  GenerationEvent,
  MessageDto,
  McpServerDto,
  McpServerInput,
  ModelDto,
  ModelInput,
  PatchConversationInput,
  ToolCallDto,
  ToolCatalogItemDto,
  ToolSettingsDto,
  ToolSettingsInput
} from "@llm-chat/contracts";

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers
  });
  if (!response.ok) {
    let code = "request_failed";
    let message = `请求失败（${response.status}）`;
    try {
      const body = await response.json() as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Keep the safe HTTP error message.
    }
    throw new ApiClientError(code, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  settings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  connections: () => request<ConnectionDto[]>("/api/connections"),
  createConnection: (input: ConnectionInput) => request<ConnectionDto>("/api/connections", { method: "POST", body: JSON.stringify(input) }),
  updateConnection: (id: string, input: Partial<ConnectionInput>) => request<ConnectionDto>(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => request<{ ok: boolean; modelsFound: number }>(`/api/connections/${id}/test`, { method: "POST" }),
  discoverModels: (id: string) => request<{ discovered: number; created: ModelDto[] }>(`/api/connections/${id}/models/discover`, { method: "POST" }),
  models: () => request<ModelDto[]>("/api/models"),
  createModel: (input: ModelInput) => request<ModelDto>("/api/models", { method: "POST", body: JSON.stringify(input) }),
  updateModel: (id: string, input: Partial<ModelInput>) => request<ModelDto>(`/api/models/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteModel: (id: string) => request<void>(`/api/models/${id}`, { method: "DELETE" }),
  conversations: () => request<ConversationDto[]>("/api/conversations"),
  createConversation: (input: { systemPrompt: string }) => request<ConversationDto>("/api/conversations", { method: "POST", body: JSON.stringify(input) }),
  startConversation: (input: { text: string; modelId: string; contextPolicy?: ContextPolicy }) => request<ConversationStartedDto>("/api/conversations/start", { method: "POST", body: JSON.stringify(input) }),
  updateConversation: (id: string, patch: PatchConversationInput) => request<ConversationDto>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  messages: (id: string) => request<MessageDto[]>(`/api/conversations/${id}/messages`),
  send: (conversationId: string, input: { text: string }) => request<GenerationCreatedDto>(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify(input) }),
  retry: (messageId: string) => request<GenerationCreatedDto>(`/api/messages/${messageId}/generations`, { method: "POST", body: "{}" }),
  selectGeneration: (messageId: string, generationId: string) => request<{ ok: boolean }>(`/api/messages/${messageId}/active-generation`, { method: "PATCH", body: JSON.stringify({ generationId }) }),
  cancel: (generationId: string) => request<{ ok: boolean }>(`/api/generations/${generationId}/cancel`, { method: "POST" }),
  generation: (generationId: string) => request<GenerationDto>(`/api/generations/${generationId}`),
  toolSettings: () => request<ToolSettingsDto>("/api/tools/settings"),
  updateToolSettings: (input: ToolSettingsInput) => request<ToolSettingsDto>("/api/tools/settings", { method: "PATCH", body: JSON.stringify(input) }),
  toolCatalog: () => request<ToolCatalogItemDto[]>("/api/tools/catalog"),
  approveTool: (id: string, approved: boolean, reason?: string) => request<{ toolCall: ToolCallDto; generationId: string; resumed: boolean }>(`/api/tool-calls/${encodeURIComponent(id)}/approval`, {
    method: "POST", body: JSON.stringify({ approved, ...(reason ? { reason } : {}) })
  }),
  mcpServers: () => request<McpServerDto[]>("/api/mcp/servers"),
  createMcpServer: (input: McpServerInput) => request<McpServerDto>("/api/mcp/servers", { method: "POST", body: JSON.stringify(input) }),
  updateMcpServer: (id: string, input: Partial<McpServerInput>) => request<McpServerDto>(`/api/mcp/servers/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMcpServer: (id: string) => request<void>(`/api/mcp/servers/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => request<{ ok: true; tools: number; serverName: string }>(`/api/mcp/servers/${id}/test`, { method: "POST" })
};

export function generationEvents(generationId: string, onEvent: (event: GenerationEvent) => void): () => void {
  const source = new EventSource(`/api/generations/${generationId}/events`);
  const names: GenerationEvent["type"][] = ["snapshot", "block-delta", "tool-call", "usage", "status", "error"];
  for (const name of names) {
    source.addEventListener(name, (event) => {
      try {
        onEvent(JSON.parse((event as MessageEvent<string>).data) as GenerationEvent);
      } catch {
        // Ignore malformed local events; a later snapshot is authoritative.
      }
    });
  }
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) source.close();
  };
  return () => source.close();
}
