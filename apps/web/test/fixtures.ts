import type { AgentSummaryDto, AppSettings, BackgroundTaskDto, ConnectionDto, ConversationDto, GenerationDto, MessageDto, ModelDto } from "@llm-chat/contracts";

export function makeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultModelId: null,
    defaultContextPolicy: "trim",
    theme: "dark",
    defaultSystemPrompt: "",
    reasoningEffort: "medium",
    defaultAgentId: "agent-1",
    lastAgentId: "agent-1",
    userProfile: { displayName: "主人", description: "" },
    uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer", generationHaptics: true },
    lastWorkspacePath: null,
    ...patch
  };
}

export function makeAgent(patch: Partial<AgentSummaryDto> = {}): AgentSummaryDto {
  return {
    id: "agent-1",
    name: "测试助手",
    description: "测试用 Agent",
    protected: true,
    revision: 1,
    hasAvatar: false,
    modelId: "model-1",
    execution: {
      modelId: "model-1",
      visionModelId: null,
      contextPolicy: "trim",
      reasoningEffort: "medium",
      generation: {},
      tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} },
      enabledSkillIds: [],
      maxToolRounds: 32,
      maxBackgroundTasks: 2,
      taskLogLimitBytes: 64 * 1024 * 1024
    },
    userProfile: {},
    firstMessage: "你好！",
    alternateGreetings: [],
    roleplayEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

export function makeConversation(patch: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: "conv-1",
    title: "测试会话",
    systemPrompt: "",
    contextPolicy: "trim",
    modelId: "model-1",
    agentId: "agent-1",
    executionOverrides: {},
    workspacePath: null,
    draft: "",
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

export function makeConnection(patch: Partial<ConnectionDto> = {}): ConnectionDto {
  return {
    id: "connection-1",
    name: "测试连接",
    protocol: "openai-chat",
    baseUrl: "https://example.com/v1",
    hasApiKey: true,
    secretHeaderNames: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

export function makeModel(patch: Partial<ModelDto> = {}): ModelDto {
  return {
    id: "model-1",
    connectionId: "connection-1",
    modelKey: "gpt-test",
    displayName: "GPT 测试",
    contextWindow: 128_000,
    maxInputTokens: null,
    maxOutputTokens: 8_192,
    capabilities: {
      imageInput: false,
      tools: true,
      temperature: true,
      topP: true,
      reasoning: true,
      reasoningSummary: true,
      adaptiveThinking: false,
      manualThinking: false
    },
    defaultSettings: { common: { maxOutputTokens: 8_192, stopSequences: [] }, protocol: {} },
    enabled: true,
    source: "manual",
    catalogManaged: false,
    catalogMetadata: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

export function makeGeneration(patch: Partial<GenerationDto> = {}): GenerationDto {
  return {
    id: "gen-1",
    version: 1,
    generationKind: "normal",
    status: "completed",
    connectionName: "test-conn",
    protocol: "openai-chat",
    modelKey: "gpt-test",
    settings: {
      common: { maxOutputTokens: 4096, stopSequences: [] },
      protocol: {},
      reasoningEffort: "medium"
    },
    generatedAgent: { agentId: "agent-1", name: "测试助手", revision: 1 },
    blocks: [],
    toolCalls: [],
    visionAnalyses: [],
    usage: {},
    stopReason: null,
    error: null,
    context: null,
    createdAt: 2,
    completedAt: 3,
    ...patch
  };
}

export function makeMessage(patch: Partial<MessageDto> = {}): MessageDto {
  return {
    id: "msg-1",
    ordinal: 1,
    role: "assistant",
    text: null,
    generatedModel: null,
    attachments: [],
    activeGenerationId: null,
    generations: [],
    greeting: null,
    createdAt: 2,
    ...patch
  };
}

export function makeBackgroundTask(patch: Partial<BackgroundTaskDto> = {}): BackgroundTaskDto {
  return {
    id: "task-1",
    conversationId: "conv-1",
    generationId: "gen-1",
    agentId: "agent-1",
    agentName: "测试助手",
    agentRevision: 1,
    command: "pnpm test",
    mode: "pipe",
    workspacePath: "/workspace",
    status: "completed",
    expectedDurationMs: null,
    hardTimeoutMs: null,
    overdue: false,
    exitCode: 0,
    error: null,
    outputCursor: 0,
    earliestCursor: 0,
    createdAt: 1,
    startedAt: 2,
    completedAt: 3,
    ...patch
  };
}
