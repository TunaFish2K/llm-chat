import type {
  AgentDto,
  AgentInput,
  AgentSearchSecretDto,
  AgentSearchSecretInput,
  AgentSummaryDto,
  AppSettings,
  BackgroundTaskDto,
  BackgroundTaskEventDto,
  ConnectionBalanceDto,
  ConnectionDto,
  ConnectionInput,
  CodexCreateSessionInput,
  CodexResponseInput,
  CodexRuntimeDto,
  CodexSessionDetailDto,
  CodexSessionDto,
  CodexThreadDto,
  CodexTurnInput,
  ContextSummaryDto,
  ConversationDto,
  ConversationExecutionOverrides,
  ConversationRoleplayState,
  ConversationRoleplayStatePatch,
  RoleplayScriptExecutionDto,
  ConversationForkDto,
  ConversationStartedDto,
  DirectoryListingDto,
  GenerationCreatedDto,
  GenerationDto,
  ForkConversationInput,
  FileAssetDto,
  ImageAssetDto,
  ImageGenerationInput,
  ImageGenerationJobDto,
  McpServerDto,
  McpServerInput,
  McpServerPatch,
  MessageDto,
  ModelDto,
  ModelInput,
  PluginDto,
  SkillDiscoverySummary,
  SkillDto,
  ToolCatalogItemDto,
  ToolSettingsDto,
  ToolSettingsInput
} from "@llm-chat/contracts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

export function onAuthRequired(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function emitAuthRequired(): void {
  for (const listener of authListeners) listener();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" && method !== "HEAD" ? { "x-llm-chat-request": "1" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : null
    });
  } catch (error) {
    throw new ApiRequestError(0, "network_error", error instanceof Error ? error.message : "网络请求失败");
  }
  if (response.status === 401) {
    const text = await response.text();
    let serverMessage = "请输入访问密码";
    let serverCode = "authentication_required";
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      serverCode = parsed.error?.code ?? serverCode;
      serverMessage = parsed.error?.message ?? serverMessage;
    } catch {
      /* keep defaults */
    }
    // Only a missing/expired session invalidates global auth state. Other 401s
    // (e.g. a wrong password on the login form) stay local to the caller.
    if (serverCode === "authentication_required") emitAuthRequired();
    throw new ApiRequestError(401, serverCode, serverMessage);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiRequestError(response.status, "invalid_response", "服务端返回了无法解析的响应");
    }
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      error?.details
    );
  }
  return data as T;
}

async function uploadFile(file: File): Promise<FileAssetDto> {
  const response = await fetch("/api/files", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-llm-chat-request": "1",
      "x-file-name": encodeURIComponent(file.name || "file"),
      "x-file-type": file.type || "application/octet-stream"
    },
    body: file
  });
  if (response.status === 401) emitAuthRequired();
  const data = await response.json() as FileAssetDto | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiRequestError(response.status, error?.code ?? "upload_failed", error?.message ?? "文件上传失败");
  }
  return data as FileAssetDto;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path)
};

export interface BootstrapDto {
  settings: AppSettings;
  agents: AgentSummaryDto[];
  connections: ConnectionDto[];
  models: ModelDto[];
  conversations: ConversationDto[];
  messages?: MessageDto[];
}

export interface TaskDetailDto {
  task: BackgroundTaskDto;
  events: BackgroundTaskEventDto[];
}

export interface TaskOutputDto {
  task: BackgroundTaskDto;
  cursor: number;
  earliestCursor: number;
  gap: boolean;
  raw: string;
  text: string;
  screen: string | null;
}

export interface MemoryDto {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpTestResult {
  ok: boolean;
  tools?: number;
  error?: string;
}

export const endpoints = {
  serviceSettings: () => api.get<import("@llm-chat/contracts").ServiceSettingsDto>("/api/tools/services"),
  updateServiceSettings: (input: import("@llm-chat/contracts").ServiceSettingsInput) => api.patch<import("@llm-chat/contracts").ServiceSettingsDto>("/api/tools/services", input),
  conversationHistory: (id: string) => api.get<import("@llm-chat/contracts").ConversationHistoryDto>(`/api/conversations/${id}/history`),
  changeHistory: (id: string, input: import("@llm-chat/contracts").HistoryChangeInput) => api.post<import("@llm-chat/contracts").ConversationHistoryDto>(`/api/conversations/${id}/history`, input),
  resumeQueue: (id: string) => api.post<{ ok: true }>(`/api/conversations/${id}/queue/resume`, {}),
  queuedMessages: (id: string) => api.get<import("@llm-chat/contracts").QueuedMessageDto[]>(`/api/conversations/${id}/queued-messages`),
  enqueueMessage: (id: string, text: string, assetIds: string[]) => api.post<import("@llm-chat/contracts").QueuedMessageDto>(`/api/conversations/${id}/queued-messages`, { text, assetIds }),
  deleteQueuedMessage: (id: string, itemId?: string) => api.delete<void>(`/api/conversations/${id}/queued-messages${itemId ? `/${itemId}` : ""}`),
  login: (password: string) => api.post<{ ok: true }>("/api/auth/login", { password }),
  logout: () => api.post<undefined>("/api/auth/logout"),
  changePassword: (password: string) =>
    api.put<{ ok: true; sessionsRevoked: number }>("/api/auth/password", { password }),

  bootstrap: (conversationId?: string) =>
    api.get<BootstrapDto>(`/api/bootstrap${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`),
  settings: () => api.get<AppSettings>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) => api.patch<AppSettings>("/api/settings", patch),

  agents: () => api.get<AgentSummaryDto[]>("/api/agents"),
  agent: (id: string) => api.get<AgentDto>(`/api/agents/${id}`),
  createAgent: (input: AgentInput) => api.post<AgentDto>("/api/agents", input),
  updateAgent: (id: string, patch: Partial<AgentInput>) => api.patch<AgentDto>(`/api/agents/${id}`, patch),
  updateAgentSearchSecret: (id: string, input: AgentSearchSecretInput) =>
    api.patch<AgentSearchSecretDto>(`/api/agents/${id}/search-secret`, input),
  deleteAgent: (id: string) => api.delete<undefined>(`/api/agents/${id}`),
  importAgent: (fileName: string, dataBase64: string) =>
    api.post<AgentDto>("/api/agents/import", { fileName, dataBase64 }),
  setAgentAvatar: (id: string, fileName: string, dataBase64: string) =>
    api.put<AgentDto>(`/api/agents/${id}/avatar`, { fileName, dataBase64 }),
  deleteAgentAvatar: (id: string) => api.delete<undefined>(`/api/agents/${id}/avatar`),
  importRoleplayPreset: (id: string, fileName: string, dataBase64: string) =>
    api.post<AgentDto>(`/api/agents/${id}/roleplay/presets/import`, { fileName, dataBase64 }),
  uploadRoleplayAsset: (id: string, file: File, dataBase64: string, type: string) =>
    api.post<AgentDto>(`/api/agents/${id}/roleplay/assets`, {
      fileName: file.name, mimeType: file.type || "application/octet-stream", type, dataBase64
    }),
  deleteRoleplayAsset: (id: string, assetId: string) =>
    api.delete<undefined>(`/api/agents/${id}/roleplay/assets/${assetId}`),

  toolSettings: () => api.get<ToolSettingsDto>("/api/tools/settings"),
  updateToolSettings: (patch: ToolSettingsInput) => api.patch<ToolSettingsDto>("/api/tools/settings", patch),
  toolCatalog: (agentId?: string) => api.get<ToolCatalogItemDto[]>(
    `/api/tools/catalog${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`
  ),

  plugins: () => api.get<PluginDto[]>("/api/plugins"),
  installPlugin: (sourcePath: string) => api.post<PluginDto>("/api/plugins/install", { sourcePath }),
  configurePlugin: (id: string, config: Record<string, unknown>, secrets: Record<string, unknown>) =>
    api.patch<PluginDto>(`/api/plugins/${id}/config`, { config, secrets }),
  reloadPlugin: (id: string) => api.post<PluginDto>(`/api/plugins/${id}/reload`),
  unloadPlugin: (id: string) => api.post<PluginDto>(`/api/plugins/${id}/unload`),
  removePlugin: (id: string) => api.delete<undefined>(`/api/plugins/${id}`),

  skills: () => api.get<SkillDto[]>("/api/skills"),
  discoverSkills: () => api.post<SkillDiscoverySummary>("/api/skills/discover"),
  installSkill: (sourcePath: string) => api.post<SkillDto>("/api/skills/install", { sourcePath }),
  reloadSkill: (id: string) => api.post<SkillDto>(`/api/skills/${id}/reload`),
  removeSkill: (id: string) => api.delete<undefined>(`/api/skills/${id}`),

  memories: () => api.get<MemoryDto[]>("/api/memories"),

  mcpServers: () => api.get<McpServerDto[]>("/api/mcp/servers"),
  createMcpServer: (input: McpServerInput) => api.post<McpServerDto>("/api/mcp/servers", input),
  updateMcpServer: (id: string, patch: McpServerPatch) => api.patch<McpServerDto>(`/api/mcp/servers/${id}`, patch),
  deleteMcpServer: (id: string) => api.delete<undefined>(`/api/mcp/servers/${id}`),
  testMcpServer: (id: string) => api.post<McpTestResult>(`/api/mcp/servers/${id}/test`),

  connections: () => api.get<ConnectionDto[]>("/api/connections"),
  createConnection: (input: ConnectionInput) => api.post<ConnectionDto>("/api/connections", input),
  updateConnection: (id: string, patch: Partial<ConnectionInput>) =>
    api.patch<ConnectionDto>(`/api/connections/${id}`, patch),
  deleteConnection: (id: string) => api.delete<undefined>(`/api/connections/${id}`),
  connectionBalance: (id: string, refresh = false) =>
    api.get<ConnectionBalanceDto>(`/api/connections/${id}/balance${refresh ? "?refresh=1" : ""}`),
  testConnection: (id: string) => api.post<{ ok: true; modelsFound: number }>(`/api/connections/${id}/test`),
  discoverModels: (id: string) =>
    api.post<{
      discovered: number;
      created: ModelDto[];
      updated: ModelDto[];
      skipped: number;
      unmatched: number;
      warnings: string[];
    }>(`/api/connections/${id}/models/discover`),

  models: (connectionId?: string) =>
    api.get<ModelDto[]>(`/api/models${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  createModel: (input: ModelInput) => api.post<ModelDto>("/api/models", input),
  updateModel: (id: string, patch: Partial<ModelInput>) => api.patch<ModelDto>(`/api/models/${id}`, patch),
  deleteModel: (id: string) => api.delete<undefined>(`/api/models/${id}`),
  restoreModelCatalog: (id: string) => api.post<ModelDto>(`/api/models/${id}/catalog/restore`, {}),

  conversations: () => api.get<ConversationDto[]>("/api/conversations"),
  createConversation: (input: {
    title?: string;
    agentId: string;
    executionOverrides?: ConversationExecutionOverrides;
    workspacePath?: string | null;
  }) =>
    api.post<ConversationDto>("/api/conversations", input),
  startConversation: (input: {
    text: string;
    assetIds?: string[];
    imageAssetIds?: string[];
    agentId: string;
    greetingIndex?: number;
    executionOverrides?: ConversationExecutionOverrides;
    workspacePath?: string | null;
  }) => api.post<ConversationStartedDto>("/api/conversations/start", input),
  conversation: (id: string) => api.get<ConversationDto>(`/api/conversations/${id}`),
  updateConversation: (id: string, patch: Record<string, unknown>) =>
    api.patch<ConversationDto>(`/api/conversations/${id}`, patch),
  selectConversationBranch: (id: string, branchId: string) =>
    api.patch<{ activeBranchId: string }>(`/api/conversations/${id}/active-branch`, { branchId }),
  conversationRoleplayState: (id: string) =>
    api.get<ConversationRoleplayState>(`/api/conversations/${id}/roleplay-state`),
  updateConversationRoleplayState: (id: string, patch: ConversationRoleplayStatePatch) =>
    api.patch<ConversationRoleplayState>(`/api/conversations/${id}/roleplay-state`, patch),
  executeRoleplayScript: (id: string, input: { script?: string; quickReplyId?: string; trigger?: "new_chat" | "before_send" | "after_reply" | "lore_activated"; draft?: string }) =>
    api.post<RoleplayScriptExecutionDto>(`/api/conversations/${id}/roleplay-scripts/execute`, input),
  roleplayScriptAudit: (id: string) =>
    api.get<Array<Record<string, unknown>>>(`/api/conversations/${id}/roleplay-scripts/audit`),
  deleteConversation: (id: string) => api.delete<undefined>(`/api/conversations/${id}`),
  forkConversation: (id: string, input: ForkConversationInput) =>
    api.post<ConversationForkDto>(`/api/conversations/${id}/forks`, input),
  contextSummary: (id: string) => api.get<ContextSummaryDto | null>(`/api/conversations/${id}/context/compact`),
  compactContext: (id: string) => api.post<ContextSummaryDto>(`/api/conversations/${id}/context/compact`, {}),
  messages: (conversationId: string) => api.get<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  imageGenerations: (conversationId: string) => api.get<ImageGenerationJobDto[]>(`/api/conversations/${conversationId}/image-generations`),
  startImageGeneration: (conversationId: string, input: ImageGenerationInput) =>
    api.post<ImageGenerationJobDto>(`/api/conversations/${conversationId}/image-generations`, input),
  imageGeneration: (id: string) => api.get<ImageGenerationJobDto>(`/api/image-generations/${id}`),
  cancelImageGeneration: (id: string) => api.post<ImageGenerationJobDto>(`/api/image-generations/${id}/cancel`, {}),
  retryImageGeneration: (id: string) => api.post<ImageGenerationJobDto>(`/api/image-generations/${id}/retry`, {}),
  uploadImage: (fileName: string, dataBase64: string) =>
    api.post<ImageAssetDto>("/api/images", { fileName, dataBase64 }),
  uploadFile,
  sendMessage: (conversationId: string, text: string, assetIds: string[] = []) =>
    api.post<GenerationCreatedDto>(`/api/conversations/${conversationId}/messages`, {
      text,
      ...(assetIds.length ? { assetIds } : {})
    }),
  retryGeneration: (messageId: string) => api.post<GenerationCreatedDto>(`/api/messages/${messageId}/generations`, {}),
  selectGeneration: (messageId: string, generationId: string) =>
    api.patch<{ ok: true }>(`/api/messages/${messageId}/active-generation`, { generationId }),
  cancelGeneration: (generationId: string) =>
    api.post<{ ok: boolean; status: GenerationDto["status"] | "stopping" }>(`/api/generations/${generationId}/cancel`),
  generation: (id: string) => api.get<GenerationDto>(`/api/generations/${id}`),
  resolveToolCall: (toolCallId: string, approved: boolean, reason?: string) =>
    api.post<{ toolCall: unknown; generationId: string; resumed: boolean }>(
      `/api/tool-calls/${toolCallId}/approval`,
      reason ? { approved, reason } : { approved }
    ),

  backgroundTasks: (conversationId?: string, scope?: "current" | "all") => {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    else if (conversationId) params.set("conversationId", conversationId);
    const suffix = params.size ? `?${params.toString()}` : "";
    return api.get<BackgroundTaskDto[]>(`/api/background-tasks${suffix}`);
  },
  backgroundTask: (id: string) => api.get<TaskDetailDto>(`/api/background-tasks/${id}`),
  backgroundTaskOutput: (id: string, cursor: number) =>
    api.get<TaskOutputDto>(`/api/background-tasks/${id}/output?cursor=${cursor}`),
  stopBackgroundTask: (id: string, reason: string) =>
    api.post<BackgroundTaskDto>(`/api/background-tasks/${id}/stop`, { reason }),
  resizeBackgroundTask: (id: string, columns: number, rows: number) =>
    api.post<{ ok: true }>(`/api/background-tasks/${id}/resize`, { columns, rows }),

  codexRuntime: () => api.get<CodexRuntimeDto>("/api/codex/runtime"),
  codexThreads: (cwd?: string) => api.get<CodexThreadDto[]>(`/api/codex/threads${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  codexSessions: (conversationId?: string) => api.get<CodexSessionDto[]>(
    `/api/codex/sessions${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`
  ),
  createCodexSession: (input: CodexCreateSessionInput) => api.post<CodexSessionDto>("/api/codex/sessions", input),
  codexSession: (id: string, after = 0) => api.get<CodexSessionDetailDto>(`/api/codex/sessions/${id}?after=${after}`),
  sendCodexTurn: (id: string, input: CodexTurnInput) => api.post<CodexSessionDto>(`/api/codex/sessions/${id}/turns`, input),
  respondCodex: (id: string, input: CodexResponseInput) => api.post<CodexSessionDto>(`/api/codex/sessions/${id}/respond`, input),
  interruptCodex: (id: string) => api.post<CodexSessionDto>(`/api/codex/sessions/${id}/interrupt`),
  detachCodex: (id: string) => api.delete<void>(`/api/codex/sessions/${id}`),

  listDirectories: (path?: string) =>
    api.get<DirectoryListingDto>(`/api/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  createDirectory: (path: string) => api.post<{ path: string }>("/api/filesystem/directories", { path }),
  validatePath: (path: string) => api.post<{ path: string }>("/api/filesystem/validate", { path })
};
