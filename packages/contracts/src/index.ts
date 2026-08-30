import { z } from "zod";

export const protocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic-messages"
]);
export type ProviderProtocol = z.infer<typeof protocolSchema>;

export const contextPolicySchema = z.enum(["trim", "summarize", "full"]);
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export const generationStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-approval",
  "completed",
  "stopped",
  "failed",
  "interrupted"
]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const blockTypeSchema = z.enum(["text", "reasoning", "refusal", "unsupported"]);
export type BlockType = z.infer<typeof blockTypeSchema>;

/** Raw reasoning effort names exposed by the global control. */
export const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const commonSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  stopSequences: z.array(z.string().min(1).max(256)).max(8).default([])
});

/**
 * Protocol-level knobs that still legitimately live on a model's
 * defaultSettings: reasoningSummary / thinkingBudgetTokens.
 * `reasoningEffort`, `thinkingMode`, `anthropicEffort`, `verbosity`
 * are deprecated write targets; new generations must not write
 * them. They are kept in the schema purely so that historical
 * generations' `settings_json` can still be parsed and displayed.
 */
export const protocolSettingsSchema = z.object({
  /** @deprecated read-only compat for old snapshots. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  reasoningSummary: z.enum(["auto", "concise", "detailed"]).optional(),
  /** @deprecated read-only compat for old snapshots. */
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  /** @deprecated read-only compat for old snapshots. */
  thinkingMode: z.enum(["off", "adaptive", "enabled"]).optional(),
  thinkingBudgetTokens: z.number().int().min(1024).optional(),
  /** @deprecated read-only compat for old snapshots. */
  anthropicEffort: z.enum(["low", "medium", "high", "max"]).optional()
});

export const modelSettingsSchema = z.object({
  common: commonSettingsSchema,
  protocol: protocolSettingsSchema.default({})
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const generationSettingsSchema = modelSettingsSchema.extend({
  reasoningEffort: reasoningEffortSchema,
  /** Resolved token budget used by Anthropic manual Thinking. */
  resolvedThinkingBudgetTokens: z.number().int().min(1024).optional()
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const modelCapabilitiesSchema = z.object({
  tools: z.boolean().default(true),
  temperature: z.boolean().default(true),
  topP: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  reasoningSummary: z.boolean().default(false),
  adaptiveThinking: z.boolean().default(false),
  manualThinking: z.boolean().default(false)
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: protocolSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().max(4096).optional(),
  secretHeaders: z.record(z.string(), z.string().max(4096)).default({})
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

export interface ConnectionDto {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  secretHeaderNames: string[];
  createdAt: number;
  updatedAt: number;
}

export const modelInputSchema = z.object({
  connectionId: z.string().uuid(),
  modelKey: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().max(10_000_000).nullable(),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  capabilities: modelCapabilitiesSchema,
  defaultSettings: modelSettingsSchema,
  enabled: z.boolean().default(true)
});
export type ModelInput = z.infer<typeof modelInputSchema>;

export interface ModelDto extends ModelInput {
  id: string;
  source: "manual" | "discovered";
  createdAt: number;
  updatedAt: number;
}

export const appSettingsSchema = z.object({
  defaultModelId: z.string().uuid().nullable(),
  defaultContextPolicy: contextPolicySchema,
  theme: z.enum(["system", "light", "dark"]),
  defaultSystemPrompt: z.string().max(100_000),
  reasoningEffort: reasoningEffortSchema,
  uiPreferences: z.object({
    sidebarCollapsed: z.boolean(),
    reasoningCollapsePolicy: z.enum(["always-collapsed", "collapse-on-answer", "never-auto-collapse"])
  })
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const conversationInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).default(""),
  contextPolicy: contextPolicySchema.optional()
});

export interface ConversationDto {
  id: string;
  title: string;
  systemPrompt: string;
  contextPolicy: ContextPolicy;
  modelId: string | null;
  draft: string;
  createdAt: number;
  updatedAt: number;
}

export interface GeneratedModelDto {
  modelId: string;
  displayName: string;
  modelKey: string;
  connectionName: string;
  protocol: ProviderProtocol;
}

export interface GenerationBlockDto {
  id: string;
  index: number;
  type: BlockType;
  content: string;
  complete: boolean;
}

export interface UsageDto {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export const toolApprovalStateSchema = z.enum([
  "auto",
  "pending",
  "approved",
  "denied",
  "running",
  "completed",
  "failed"
]);
export type ToolApprovalState = z.infer<typeof toolApprovalStateSchema>;

export interface ToolCallDto {
  id: string;
  index: number;
  name: string;
  arguments: string;
  approvalState: ToolApprovalState;
  requiresApproval: boolean;
  output: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface GenerationDto {
  id: string;
  version: number;
  status: GenerationStatus;
  connectionName: string;
  protocol: ProviderProtocol;
  modelKey: string;
  /** Effective settings actually used for this generation. */
  settings: GenerationSettings;
  blocks: GenerationBlockDto[];
  toolCalls: ToolCallDto[];
  usage: UsageDto;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  context: {
    policy: ContextPolicy;
    omittedMessages: number;
    estimatedInputTokens: number;
    summaryUsed: boolean;
  } | null;
  createdAt: number;
  completedAt: number | null;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant";
  text: string | null;
  generatedModel: GeneratedModelDto | null;
  activeGenerationId: string | null;
  generations: GenerationDto[];
  createdAt: number;
}

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(1_000_000)
});

export const startConversationSchema = sendMessageSchema.extend({
  modelId: z.string().uuid(),
  contextPolicy: contextPolicySchema.optional()
});

export const retryGenerationSchema = z.object({});

export const patchConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  contextPolicy: contextPolicySchema.optional(),
  modelId: z.string().uuid().nullable().optional(),
  draft: z.string().max(1_000_000).optional()
});
export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

export interface GenerationCreatedDto {
  userMessageId?: string;
  assistantMessageId: string;
  generationId: string;
}

export interface ConversationStartedDto {
  conversation: ConversationDto;
  generation: GenerationCreatedDto;
}

export type GenerationEvent =
  | { type: "snapshot"; generation: GenerationDto }
  | { type: "block-delta"; generationId: string; block: GenerationBlockDto }
  | { type: "usage"; generationId: string; usage: UsageDto }
  | { type: "tool-call"; generationId: string; toolCall: ToolCallDto }
  | { type: "status"; generationId: string; status: GenerationStatus; stopReason?: string }
  | { type: "error"; generationId: string; code: string; message: string };

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const toolApprovalInputSchema = z.object({
  approved: z.boolean(),
  reason: z.string().max(2_000).optional()
});

export const toolSettingsInputSchema = z.object({
  enabled: z.record(z.string(), z.boolean()).optional(),
  search: z.object({
    baseUrl: z.string().url().or(z.literal("")),
    apiKey: z.string().max(4096).optional()
  }).optional(),
  workspaceShellEnabled: z.boolean().optional()
});
export type ToolSettingsInput = z.infer<typeof toolSettingsInputSchema>;

export interface ToolSettingsDto {
  enabled: Record<string, boolean>;
  search: { baseUrl: string; hasApiKey: boolean };
  workspaceShellEnabled: boolean;
  workspacePath: string;
  skillsPath: string;
}

export interface ToolCatalogItemDto {
  name: string;
  label: string;
  description: string;
  category: "web" | "local" | "workspace" | "memory" | "conversation" | "skill" | "mcp";
  requiresApproval: boolean;
  available: boolean;
}

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9]+$/, "名称只能包含英文字母和数字"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string().max(4096)).default({}),
  enabled: z.boolean().default(true)
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export interface McpServerDto {
  id: string;
  name: string;
  url: string;
  headerNames: string[];
  enabled: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
