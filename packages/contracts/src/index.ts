import { z } from "zod";

export const protocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic-messages"
]);
export type ProviderProtocol = z.infer<typeof protocolSchema>;

export const contextPolicySchema = z.enum(["auto", "trim", "summarize", "full"]);
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
  imageInput: z.boolean().default(false),
  temperature: z.boolean().default(true),
  topP: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  reasoningSummary: z.boolean().default(false),
  adaptiveThinking: z.boolean().default(false),
  manualThinking: z.boolean().default(false)
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const BALANCE_EXPRESSION_MAX_LENGTH = 512;

const rootRelativeApiPathSchema = z.string().trim().min(1).max(2048).superRefine((value, context) => {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "apiPath must be a root-relative path" });
    return;
  }
  try {
    const url = new URL(value, "https://balance.invalid");
    if (url.origin !== "https://balance.invalid") {
      context.addIssue({ code: "custom", message: "apiPath must stay on the connection origin" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "apiPath must be a valid root-relative path" });
  }
});

export const balanceConfigSchema = z.object({
  enabled: z.boolean(),
  apiPath: rootRelativeApiPathSchema,
  resultExpression: z.string().trim().min(1).max(BALANCE_EXPRESSION_MAX_LENGTH)
});
export type BalanceConfig = z.infer<typeof balanceConfigSchema>;

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: protocolSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().max(4096).optional(),
  secretHeaders: z.record(z.string(), z.string().max(4096)).default({}),
  balanceConfig: balanceConfigSchema.optional()
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

export interface ConnectionDto {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  secretHeaderNames: string[];
  balanceConfig?: BalanceConfig;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionBalanceDto {
  connectionId: string;
  value: number;
  fetchedAt: number;
  cached: boolean;
}

export const modelInputSchema = z.object({
  connectionId: z.string().uuid(),
  modelKey: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().max(10_000_000).nullable(),
  maxInputTokens: z.number().int().positive().max(10_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  capabilities: modelCapabilitiesSchema,
  defaultSettings: modelSettingsSchema,
  enabled: z.boolean().default(true)
});
export type ModelInput = z.infer<typeof modelInputSchema>;

export const modelCatalogPricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  tiers: z.array(z.object({
    contextTokens: z.number().int().positive().optional(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional()
  })).default([])
});

export const modelCatalogMetadataSchema = z.object({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  family: z.string().max(200).optional(),
  releaseDate: z.string().max(40).optional(),
  inputModalities: z.array(z.string().max(40)).max(20).default([]),
  outputModalities: z.array(z.string().max(40)).max(20).default([]),
  reasoningEfforts: z.array(reasoningEffortSchema).max(20).default([]),
  pricing: modelCatalogPricingSchema.optional(),
  fetchedAt: z.number().int().nonnegative()
});
export type ModelCatalogMetadata = z.infer<typeof modelCatalogMetadataSchema>;

export interface ModelDto extends Omit<ModelInput, "maxInputTokens"> {
  id: string;
  maxInputTokens: number | null;
  source: "manual" | "discovered";
  catalogManaged: boolean;
  catalogMetadata: ModelCatalogMetadata | null;
  createdAt: number;
  updatedAt: number;
}

export const characterBookEntrySchema = z.object({
  keys: z.array(z.string()).default([]),
  content: z.string().default(""),
  extensions: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  insertion_order: z.number().int().default(0),
  case_sensitive: z.boolean().optional(),
  name: z.string().optional(),
  priority: z.number().int().optional(),
  id: z.number().int().optional(),
  comment: z.string().optional(),
  selective: z.boolean().optional(),
  secondary_keys: z.array(z.string()).optional(),
  constant: z.boolean().optional(),
  position: z.enum(["before_char", "after_char"]).optional()
}).passthrough();
export type CharacterBookEntry = z.infer<typeof characterBookEntrySchema>;

export const characterBookSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  scan_depth: z.number().int().positive().optional(),
  token_budget: z.number().int().positive().optional(),
  recursive_scanning: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).default({}),
  entries: z.array(characterBookEntrySchema).default([])
}).passthrough();
export type CharacterBook = z.infer<typeof characterBookSchema>;

export const characterCardDataSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(200_000).default(""),
  personality: z.string().max(100_000).default(""),
  scenario: z.string().max(100_000).default(""),
  first_mes: z.string().max(200_000).default(""),
  mes_example: z.string().max(500_000).default(""),
  creator_notes: z.string().max(200_000).default(""),
  system_prompt: z.string().max(200_000).default(""),
  post_history_instructions: z.string().max(200_000).default(""),
  alternate_greetings: z.array(z.string().max(200_000)).max(100).default([]),
  character_book: characterBookSchema.optional(),
  tags: z.array(z.string().max(100)).max(200).default([]),
  creator: z.string().max(200).default(""),
  character_version: z.string().max(100).default(""),
  extensions: z.record(z.string(), z.unknown()).default({})
}).passthrough();
export type CharacterCardData = z.infer<typeof characterCardDataSchema>;

export const characterCardV2Schema = z.object({
  spec: z.literal("chara_card_v2"),
  spec_version: z.literal("2.0"),
  data: characterCardDataSchema
}).passthrough();
export type CharacterCardV2 = z.infer<typeof characterCardV2Schema>;

export const generationOverridesSchema = z.object({
  common: commonSettingsSchema.partial().optional(),
  protocol: protocolSettingsSchema.partial().optional()
});
export type GenerationOverrides = z.infer<typeof generationOverridesSchema>;

const toolPolicyObjectSchema = z.object({
  defaultEnabled: z.boolean().default(true),
  overrides: z.record(z.string(), z.boolean()).default({}),
  directOverrides: z.record(z.string(), z.boolean()).default({}),
  approvalOverrides: z.record(z.string(), z.enum(["default", "always", "never"])).default({})
});
// Runtime parsing always supplies directOverrides. Its static optionality keeps
// source compatibility for callers that construct pre-v15 policies directly.
export const toolPolicySchema = toolPolicyObjectSchema as z.ZodType<{
  defaultEnabled: boolean;
  overrides: Record<string, boolean>;
  directOverrides?: Record<string, boolean>;
  approvalOverrides: Record<string, "default" | "always" | "never">;
}>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type ApprovalPolicy = "default" | "always" | "never";

export const agentExecutionConfigSchema = z.object({
  modelId: z.string().min(1).max(200).nullable(),
  visionModelId: z.string().min(1).max(200).nullable().default(null),
  contextPolicy: contextPolicySchema,
  reasoningEffort: reasoningEffortSchema,
  generation: generationOverridesSchema.default({}),
  tools: toolPolicySchema,
  enabledSkillIds: z.array(z.string().min(1).max(200)).max(500).default([]),
  maxToolRounds: z.number().int().positive().max(10_000).nullable().default(32),
  maxBackgroundTasks: z.number().int().nonnegative().max(1_000).nullable().default(2),
  taskLogLimitBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024).nullable().default(64 * 1024 * 1024)
});
export type AgentExecutionConfig = z.infer<typeof agentExecutionConfigSchema>;

export const agentUserProfileOverrideSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(20_000).optional()
});
export type AgentUserProfileOverride = z.infer<typeof agentUserProfileOverrideSchema>;

export const agentInputSchema = z.object({
  card: characterCardV2Schema,
  execution: agentExecutionConfigSchema,
  userProfile: agentUserProfileOverrideSchema.default({})
});
export type AgentInput = z.infer<typeof agentInputSchema>;

export interface AgentSummaryDto {
  id: string;
  name: string;
  description: string;
  protected: boolean;
  revision: number;
  hasAvatar: boolean;
  modelId: string | null;
  execution: AgentExecutionConfig;
  userProfile: AgentUserProfileOverride;
  firstMessage: string;
  alternateGreetings: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentDto extends AgentSummaryDto, AgentInput {}

export const encodedFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  dataBase64: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
});
export type EncodedFileInput = z.infer<typeof encodedFileSchema>;

export const conversationExecutionOverridesSchema = z.object({
  modelId: z.string().min(1).max(200).nullable().optional(),
  contextPolicy: contextPolicySchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  generation: generationOverridesSchema.optional(),
  tools: z.record(z.string(), z.boolean()).optional()
});
export type ConversationExecutionOverrides = z.infer<typeof conversationExecutionOverridesSchema>;

export const appSettingsSchema = z.object({
  defaultModelId: z.string().uuid().nullable(),
  defaultContextPolicy: contextPolicySchema,
  theme: z.enum(["system", "light", "dark"]),
  defaultSystemPrompt: z.string().max(100_000),
  reasoningEffort: reasoningEffortSchema,
  defaultAgentId: z.string().uuid(),
  lastAgentId: z.string().uuid(),
  userProfile: z.object({
    displayName: z.string().trim().min(1).max(100),
    description: z.string().max(20_000)
  }),
  uiPreferences: z.object({
    sidebarCollapsed: z.boolean(),
    reasoningCollapsePolicy: z.enum(["always-collapsed", "collapse-on-answer", "never-auto-collapse"])
  }),
  lastWorkspacePath: z.string().max(4096).nullable().default(null)
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const conversationInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().uuid(),
  executionOverrides: conversationExecutionOverridesSchema.default({}),
  workspacePath: z.string().max(4096).nullable().default(null)
});

export interface ConversationDto {
  id: string;
  title: string;
  systemPrompt: string;
  contextPolicy: ContextPolicy;
  modelId: string | null;
  agentId: string | null;
  executionOverrides: ConversationExecutionOverrides;
  workspacePath: string | null;
  forkedFrom?: { conversationId: string; messageId: string | null } | null;
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

export interface GeneratedAgentDto {
  agentId: string | null;
  name: string;
  revision: number;
}

export const greetingMessageSchema = z.object({
  variants: z.array(z.string().max(200_000)).min(1).max(101),
  activeIndex: z.number().int().nonnegative(),
  agent: z.object({
    agentId: z.string().uuid().nullable(),
    name: z.string().min(1).max(200),
    revision: z.number().int().positive()
  })
}).refine((value) => value.activeIndex < value.variants.length, {
  message: "activeIndex must reference a greeting variant"
});
export type GreetingMessageDto = z.infer<typeof greetingMessageSchema>;

export interface GenerationBlockDto {
  id: string;
  index: number;
  stepIndex: number;
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
  /** Provider-visible call ID; differs from id for cloned branch history. */
  providerId?: string;
  index: number;
  stepIndex: number;
  name: string;
  arguments: string;
  approvalState: ToolApprovalState;
  requiresApproval: boolean;
  output: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  artifacts: FileAssetDto[];
}

export interface FileAssetDto {
  id: string;
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
  byteSize: number;
  sha256: string;
  url: string;
  createdAt: number;
}

export interface ImageAssetDto extends FileAssetDto {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  kind: "image";
}

export interface VisionAnalysisDto {
  id: string;
  asset: ImageAssetDto;
  status: "running" | "completed" | "failed";
  model: GeneratedModelDto;
  description: string | null;
  usage: UsageDto;
  cached: boolean;
  error: string | null;
  createdAt: number;
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
  generatedAgent?: GeneratedAgentDto | null;
  blocks: GenerationBlockDto[];
  toolCalls: ToolCallDto[];
  visionAnalyses: VisionAnalysisDto[];
  usage: UsageDto;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  context: {
    policy: ContextPolicy;
    strategy?: "raw" | "full" | "trim" | "summary" | "summary-trim";
    omittedMessages: number;
    estimatedInputTokens: number;
    summaryUsed: boolean;
    summaryId?: string | null;
    fallbackReason?: string | null;
  } | null;
  createdAt: number;
  completedAt: number | null;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant";
  text: string | null;
  attachments: FileAssetDto[];
  generatedModel: GeneratedModelDto | null;
  activeGenerationId: string | null;
  generations: GenerationDto[];
  greeting: GreetingMessageDto | null;
  createdAt: number;
}

const messageTextSchema = z.string().trim().max(1_000_000).default("");
const imageAssetIdsSchema = z.array(z.string().uuid()).max(4).default([]);
const fileAssetIdsSchema = z.array(z.string().uuid()).max(8);

export const sendMessageSchema = z.object({
  text: messageTextSchema,
  assetIds: fileAssetIdsSchema.optional(),
  imageAssetIds: imageAssetIdsSchema
}).refine((value) => value.text.length > 0 || (value.assetIds?.length ?? 0) > 0 || value.imageAssetIds.length > 0, {
  message: "Message text or at least one attachment is required"
});

export const startConversationSchema = sendMessageSchema.extend({
  agentId: z.string().uuid(),
  greetingIndex: z.number().int().nonnegative().max(100).default(0),
  executionOverrides: conversationExecutionOverridesSchema.default({}),
  workspacePath: z.string().max(4096).nullable().default(null)
});

export const retryGenerationSchema = z.object({});

export const forkConversationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("edit"),
    messageId: z.string().uuid(),
    text: messageTextSchema,
    assetIds: fileAssetIdsSchema.optional(),
    imageAssetIds: imageAssetIdsSchema
  }).refine((value) => value.text.length > 0 || (value.assetIds?.length ?? 0) > 0 || value.imageAssetIds.length > 0, {
    message: "Message text or at least one attachment is required"
  }),
  z.object({
    mode: z.literal("continue"),
    throughMessageId: z.string().uuid().nullable()
  }),
  z.object({
    mode: z.literal("greeting"),
    messageId: z.string().uuid(),
    greetingIndex: z.number().int().nonnegative().max(100)
  })
]);
export type ForkConversationInput = z.input<typeof forkConversationSchema>;

export const patchConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().uuid().nullable().optional(),
  executionOverrides: conversationExecutionOverridesSchema.optional(),
  draft: z.string().max(1_000_000).optional(),
  workspacePath: z.string().max(4096).nullable().optional()
});
export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

export const imageUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  dataBase64: z.string().min(1).max(7_500_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
});
export type ImageUploadInput = z.infer<typeof imageUploadSchema>;

export const fileUploadMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(255).default("application/octet-stream")
});
export type FileUploadMetadata = z.infer<typeof fileUploadMetadataSchema>;

export interface GenerationCreatedDto {
  userMessageId?: string;
  assistantMessageId: string;
  generationId: string;
}

export interface ConversationStartedDto {
  conversation: ConversationDto;
  generation: GenerationCreatedDto;
}

export interface ConversationForkDto {
  conversation: ConversationDto;
  generation: GenerationCreatedDto | null;
}

export interface ContextSummaryDto {
  id: string;
  conversationId: string;
  throughOrdinal: number;
  text: string;
  connectionId: string;
  modelKey: string;
  usage: UsageDto;
  createdAt: number;
}

export type GenerationEvent =
  | { type: "snapshot"; generation: GenerationDto }
  | { type: "block-delta"; generationId: string; block: GenerationBlockDto }
  | { type: "usage"; generationId: string; usage: UsageDto }
  | { type: "tool-call"; generationId: string; toolCall: ToolCallDto }
  | { type: "vision-analysis"; generationId: string; analysis: VisionAnalysisDto }
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
  category: "web" | "local" | "workspace" | "memory" | "conversation" | "skill" | "mcp" | "background" | "plugin" | "app";
  requiresApproval: boolean;
  available: boolean;
  approvalMode?: "always" | "never" | "dynamic";
  sourceKind?: "builtin" | "plugin" | "mcp";
  sourceId?: string;
  sourceName?: string;
  revision?: string;
  operationalState?: "loaded" | "pending-reload" | "error" | "unloaded";
  error?: string | null;
}

export const pluginManifestSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  apiVersion: z.literal(1),
  entry: z.string().min(1).max(500),
  description: z.string().max(20_000).default(""),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  secretFields: z.array(z.string().min(1).max(200)).max(100).default([])
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface PluginDto {
  id: string;
  manifest: PluginManifest;
  revision: string;
  sourcePath: string;
  state: "loaded" | "pending-reload" | "error" | "unloaded";
  error: string | null;
  config: Record<string, unknown>;
  configuredSecretFields: string[];
  installedAt: number;
  updatedAt: number;
}

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  revision: string;
  sourcePath: string;
  state: "loaded" | "pending-reload" | "error" | "unloaded";
  error: string | null;
  requiredTools: string[];
  recommendedApprovals: Record<string, ApprovalPolicy>;
  bundled: boolean;
  /** Optional on input-facing consumers for compatibility; server DTOs always include it. */
  sourceKind?: "bundled" | "manual" | "agents";
  compatibility?: string | null;
  installedAt: number;
  updatedAt: number;
}

export interface SkillDiscoveryError {
  path: string;
  message: string;
}

export interface SkillDiscoverySummary {
  discovered: number;
  updated: number;
  unchanged: number;
  unloaded: number;
  errors: SkillDiscoveryError[];
}

export const backgroundTaskStatusSchema = z.enum([
  "queued", "starting", "running", "completed", "failed", "stopped", "timed_out", "interrupted"
]);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

export interface BackgroundTaskDto {
  id: string;
  conversationId: string;
  generationId: string;
  agentId: string | null;
  agentName: string;
  agentRevision: number;
  command: string;
  mode: "pipe" | "pty";
  workspacePath: string;
  status: BackgroundTaskStatus;
  expectedDurationMs: number | null;
  hardTimeoutMs: number | null;
  overdue: boolean;
  exitCode: number | null;
  error: string | null;
  outputCursor: number;
  earliestCursor: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface BackgroundTaskEventDto {
  id: number;
  taskId: string;
  type: "state" | "output" | "write" | "stop" | "warning";
  reason: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface DirectoryEntryDto {
  name: string;
  path: string;
  directory: boolean;
  hidden: boolean;
}

export interface DirectoryListingDto {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntryDto[];
}

export type AppEvent =
  | { id: number; type: "task"; taskId: string; task: BackgroundTaskDto }
  | { id: number; type: "task-output"; taskId: string; cursor: number }
  | { id: number; type: "plugin"; pluginId: string; state: PluginDto["state"]; message?: string }
  | { id: number; type: "skill"; skillId: string; state: SkillDto["state"]; message?: string }
  | { id: number; type: "resource-changed"; resource: "agents" | "conversations" | "settings" | "connections" | "models" | "mcp" | "skills" | "plugins" | "tools"; resourceId?: string };

const mcpServerFields = {
  name: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9]+$/, "名称只能包含英文字母和数字"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string().max(4096)),
  enabled: z.boolean()
};

export const mcpServerInputSchema = z.object({
  ...mcpServerFields,
  headers: mcpServerFields.headers.default({}),
  enabled: mcpServerFields.enabled.default(true)
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export const mcpServerPatchSchema = z.object(mcpServerFields).partial();
export type McpServerPatch = z.infer<typeof mcpServerPatchSchema>;

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
