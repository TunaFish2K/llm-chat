import type {
  AgentDto,
  AgentInput,
  AgentSummaryDto,
  AppSettings,
  AppEvent,
  BackgroundTaskDto,
  BackgroundTaskEventDto,
  ConnectionDto,
  ConnectionBalanceDto,
  ConnectionInput,
  DirectoryListingDto,
  ConversationExecutionOverrides,
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
  PluginDto,
  SkillDiscoverySummary,
  SkillDto,
  ToolCallDto,
  ToolCatalogItemDto,
  ToolSettingsDto,
  ToolSettingsInput
} from "@llm-chat/contracts";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/browser";

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export interface BootstrapDto {
  settings: AppSettings;
  agents: AgentSummaryDto[];
  connections: ConnectionDto[];
  models: ModelDto[];
  conversations: ConversationDto[];
  messages?: MessageDto[];
}

export interface AuthDeviceDto {
  id: string;
  name: string;
  current: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  approvedByName: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface EnrollmentOptionsDto {
  id: string;
  tabSecret: string;
  approvalSecret: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  expiresAt: number;
}

export interface ApprovalDetailsDto {
  id: string;
  deviceName: string;
  browser: string;
  ip: string;
  expiresAt: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    headers.set("x-llm-chat-request", "1");
  }
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
    if (response.status === 401 && code === "authentication_required") {
      window.dispatchEvent(new Event("llm-chat-auth-required"));
    }
    throw new ApiClientError(code, message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  bootstrap: (conversationId?: string | null) => request<BootstrapDto>(`/api/bootstrap${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`),
  bootstrapOptions: (requestId: string, secret: string) => request<PublicKeyCredentialCreationOptionsJSON>("/api/auth/bootstrap/options", {
    method: "POST", body: JSON.stringify({ requestId, secret })
  }),
  verifyBootstrap: (requestId: string, secret: string, deviceName: string, response: RegistrationResponseJSON) => request<{ ok: true }>("/api/auth/bootstrap/verify", {
    method: "POST", body: JSON.stringify({ requestId, secret, deviceName, response })
  }),
  enrollmentOptions: (deviceName: string) => request<EnrollmentOptionsDto>("/api/auth/enrollments/options", {
    method: "POST", body: JSON.stringify({ deviceName })
  }),
  finishEnrollment: (id: string, tabSecret: string, approvalSecret: string, response: RegistrationResponseJSON) => request<{ approvalQr: string; expiresAt: number }>(`/api/auth/enrollments/${encodeURIComponent(id)}/credential`, {
    method: "POST", body: JSON.stringify({ tabSecret, approvalSecret, response })
  }),
  enrollmentStatus: (id: string, tabSecret: string) => request<{ state: "pending" | "authenticated"; expiresAt?: number }>(`/api/auth/enrollments/${encodeURIComponent(id)}/status`, {
    headers: { "x-llm-chat-enrollment": tabSecret }
  }),
  approvalDetails: (id: string, secret: string) => request<ApprovalDetailsDto>(`/api/auth/approvals/${encodeURIComponent(id)}`, {
    headers: { "x-llm-chat-approval": secret }
  }),
  approvalOptions: (id: string, secret: string) => request<PublicKeyCredentialRequestOptionsJSON>(`/api/auth/approvals/${encodeURIComponent(id)}/options`, {
    method: "POST", headers: { "x-llm-chat-approval": secret }
  }),
  approveEnrollment: (id: string, secret: string, response: AuthenticationResponseJSON) => request<{ ok: true }>(`/api/auth/approvals/${encodeURIComponent(id)}/verify`, {
    method: "POST", headers: { "x-llm-chat-approval": secret }, body: JSON.stringify(response)
  }),
  loginOptions: () => request<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/login/options", { method: "POST" }),
  verifyLogin: (challengeId: string, response: AuthenticationResponseJSON) => request<{ ok: true }>("/api/auth/login/verify", {
    method: "POST", body: JSON.stringify({ challengeId, response })
  }),
  authDevices: () => request<AuthDeviceDto[]>("/api/auth/devices"),
  revokeAuthDevice: (id: string) => request<void>(`/api/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  settings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  connections: () => request<ConnectionDto[]>("/api/connections"),
  createConnection: (input: ConnectionInput) => request<ConnectionDto>("/api/connections", { method: "POST", body: JSON.stringify(input) }),
  updateConnection: (id: string, input: Partial<ConnectionInput>) => request<ConnectionDto>(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => request<{ ok: boolean; modelsFound: number }>(`/api/connections/${id}/test`, { method: "POST" }),
  connectionBalance: (id: string, refresh = false) => request<ConnectionBalanceDto>(`/api/connections/${id}/balance${refresh ? "?refresh=true" : ""}`),
  discoverModels: (id: string) => request<{ discovered: number; created: ModelDto[] }>(`/api/connections/${id}/models/discover`, { method: "POST" }),
  models: () => request<ModelDto[]>("/api/models"),
  createModel: (input: ModelInput) => request<ModelDto>("/api/models", { method: "POST", body: JSON.stringify(input) }),
  updateModel: (id: string, input: Partial<ModelInput>) => request<ModelDto>(`/api/models/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteModel: (id: string) => request<void>(`/api/models/${id}`, { method: "DELETE" }),
  agents: () => request<AgentSummaryDto[]>("/api/agents"),
  agent: (id: string) => request<AgentDto>(`/api/agents/${id}`),
  createAgent: (input: AgentInput) => request<AgentDto>("/api/agents", { method: "POST", body: JSON.stringify(input) }),
  updateAgent: (id: string, input: Partial<AgentInput>) => request<AgentDto>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAgent: (id: string) => request<void>(`/api/agents/${id}`, { method: "DELETE" }),
  importAgent: (fileName: string, dataBase64: string) => request<AgentDto>("/api/agents/import", {
    method: "POST", body: JSON.stringify({ fileName, dataBase64 })
  }),
  updateAgentAvatar: (id: string, fileName: string, dataBase64: string) => request<AgentDto>(`/api/agents/${id}/avatar`, {
    method: "PUT", body: JSON.stringify({ fileName, dataBase64 })
  }),
  deleteAgentAvatar: (id: string) => request<void>(`/api/agents/${id}/avatar`, { method: "DELETE" }),
  agentAvatarUrl: (id: string, revision?: number) => `/api/agents/${id}/avatar${revision ? `?v=${revision}` : ""}`,
  agentExportUrl: (id: string, format: "json" | "png") => `/api/agents/${id}/export?format=${format}`,
  conversations: () => request<ConversationDto[]>("/api/conversations"),
  createConversation: (input: { agentId: string; executionOverrides?: ConversationExecutionOverrides; workspacePath?: string | null }) => request<ConversationDto>("/api/conversations", { method: "POST", body: JSON.stringify(input) }),
  startConversation: (input: { text: string; agentId: string; greetingIndex?: number; executionOverrides?: ConversationExecutionOverrides; workspacePath?: string | null }) => request<ConversationStartedDto>("/api/conversations/start", { method: "POST", body: JSON.stringify(input) }),
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
  plugins: () => request<PluginDto[]>("/api/plugins"),
  installPlugin: (sourcePath: string) => request<PluginDto>("/api/plugins/install", { method: "POST", body: JSON.stringify({ sourcePath }) }),
  configurePlugin: (id: string, config: Record<string, unknown>, secrets: Record<string, unknown>) => request<PluginDto>(`/api/plugins/${id}/config`, { method: "PATCH", body: JSON.stringify({ config, secrets }) }),
  reloadPlugin: (id: string) => request<PluginDto>(`/api/plugins/${id}/reload`, { method: "POST" }),
  unloadPlugin: (id: string) => request<PluginDto>(`/api/plugins/${id}/unload`, { method: "POST" }),
  deletePlugin: (id: string) => request<void>(`/api/plugins/${id}`, { method: "DELETE" }),
  skills: () => request<SkillDto[]>("/api/skills"),
  discoverSkills: () => request<SkillDiscoverySummary>("/api/skills/discover", { method: "POST" }),
  installSkill: (sourcePath: string) => request<SkillDto>("/api/skills/install", { method: "POST", body: JSON.stringify({ sourcePath }) }),
  reloadSkill: (id: string) => request<SkillDto>(`/api/skills/${id}/reload`, { method: "POST" }),
  deleteSkill: (id: string) => request<void>(`/api/skills/${id}`, { method: "DELETE" }),
  directories: (path: string) => request<DirectoryListingDto>(`/api/filesystem/directories?path=${encodeURIComponent(path)}`),
  createDirectory: (path: string) => request<{ path: string }>("/api/filesystem/directories", { method: "POST", body: JSON.stringify({ path }) }),
  validateWorkspace: (path: string) => request<{ path: string }>("/api/filesystem/validate", { method: "POST", body: JSON.stringify({ path }) }),
  backgroundTasks: (conversationId?: string, all = false) => request<BackgroundTaskDto[]>(`/api/background-tasks?${all ? "scope=all" : conversationId ? `conversationId=${encodeURIComponent(conversationId)}` : ""}`),
  backgroundTask: (id: string) => request<{ task: BackgroundTaskDto; events: BackgroundTaskEventDto[] }>(`/api/background-tasks/${id}`),
  backgroundOutput: (id: string, cursor = 0, limit = 32 * 1024) => request<{ task: BackgroundTaskDto; cursor: number; earliestCursor: number; gap: boolean; raw: string; text: string; screen: string | null }>(`/api/background-tasks/${id}/output?cursor=${cursor}&limit=${limit}`),
  stopBackgroundTask: (id: string, reason: string) => request<BackgroundTaskDto>(`/api/background-tasks/${id}/stop`, { method: "POST", body: JSON.stringify({ reason }) }),
  approveTool: (id: string, approved: boolean, reason?: string) => request<{ toolCall: ToolCallDto; generationId: string; resumed: boolean }>(`/api/tool-calls/${encodeURIComponent(id)}/approval`, {
    method: "POST", body: JSON.stringify({ approved, ...(reason ? { reason } : {}) })
  }),
  mcpServers: () => request<McpServerDto[]>("/api/mcp/servers"),
  createMcpServer: (input: McpServerInput) => request<McpServerDto>("/api/mcp/servers", { method: "POST", body: JSON.stringify(input) }),
  updateMcpServer: (id: string, input: Partial<McpServerInput>) => request<McpServerDto>(`/api/mcp/servers/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMcpServer: (id: string) => request<void>(`/api/mcp/servers/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => request<{ ok: true; tools: number; serverName: string }>(`/api/mcp/servers/${id}/test`, { method: "POST" })
};

export function appEvents(onEvent: (event: AppEvent) => void): () => void {
  const source = new EventSource("/api/events");
  for (const name of ["task", "task-output", "plugin", "skill"] as const) {
    source.addEventListener(name, (event) => {
      try { onEvent(JSON.parse((event as MessageEvent<string>).data) as AppEvent); } catch {}
    });
  }
  return () => source.close();
}

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
