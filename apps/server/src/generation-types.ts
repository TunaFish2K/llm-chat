import type { ProviderMessage } from "@llm-chat/providers";
import type {
  AgentSearchConfig,
  AgentRoleplayConfig,
  CharacterCardV2,
  ConnectionDto,
  ContextPolicy,
  ConversationRoleplayState,
  FileAssetDto,
  GenerationDto,
  GenerationSettings,
  ImageAssetDto,
  ProviderProtocol,
  ReasoningEffort,
  RoleplayGenerationTrigger,
  ToolPolicy
} from "@llm-chat/contracts";

export interface ConnectionRecord extends ConnectionDto {
  apiKey: string;
  secretHeaders: Record<string, string>;
}

export interface ContextGenerationStep extends ProviderMessage {
  imageAssets?: ImageAssetDto[];
}

export interface ContextMessageRecord {
  steps?: ContextGenerationStep[];
  messageId: string;
  ordinal: number;
  role: "user" | "assistant";
  text: string;
  images?: ImageAssetDto[];
  files?: FileAssetDto[];
  providerPayload?: unknown;
  providerConnectionId?: string;
  providerProtocol?: ProviderProtocol;
  providerModelKey?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolResults?: Array<{ callId: string; name: string; content: string; isError?: boolean }>;
}

export interface GenerationRecord {
  id: string;
  assistantMessageId: string;
  conversationId: string;
  connectionId: string;
  modelId: string;
  modelKey: string;
  protocol: ProviderProtocol;
  settings: GenerationSettings;
  generationKind: RoleplayGenerationTrigger;
  agentSnapshot: AgentSnapshot;
  status: GenerationDto["status"];
}

export interface AgentSnapshot {
  agentId: string | null;
  name: string;
  revision: number;
  card: CharacterCardV2;
  userProfile: { displayName: string; description: string };
  baseSystemPrompt: string;
  roleplay: AgentRoleplayConfig;
  roleplayState: ConversationRoleplayState;
  generationKind: RoleplayGenerationTrigger;
  workspacePath: string | null;
  extensionsPinned: boolean;
  skillRevisions: Record<string, string>;
  toolRevisions: Record<string, string>;
  execution: {
    modelId: string;
    visionModelId: string | null;
    search: AgentSearchConfig;
    contextPolicy: ContextPolicy;
    reasoningEffort: ReasoningEffort;
    settings: GenerationSettings;
    tools: ToolPolicy;
    enabledSkillIds: string[];
    maxToolRounds: number | null;
    maxBackgroundTasks: number | null;
    taskLogLimitBytes: number | null;
  };
}

