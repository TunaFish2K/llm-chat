import { describe, expect, it } from "vitest";
import {
  agentExecutionConfigSchema, agentRoleplayConfigSchema, characterCardV2Schema,
  conversationRoleplayStateSchema, modelInputSchema, roleplayPresetSchema,
  type AgentDto, type ConversationDto, type ModelDto
} from "@llm-chat/contracts";
import type { ConnectionRecord } from "./generation-types";
import { buildEffectiveSettings, resolveGenerationPlan } from "./generation-policy";

function fixture() {
  const modelId = "00000000-0000-4000-8000-000000000001";
  const connection: ConnectionRecord = {
    id: "00000000-0000-4000-8000-000000000002", name: "Connection", providerId: "custom",
    protocol: "openai-chat", baseUrl: "https://example.test", hasApiKey: true, apiKey: "key",
    secretHeaders: {}, secretHeaderNames: [], createdAt: 1, updatedAt: 1
  };
  const model: ModelDto = {
    ...modelInputSchema.parse({ connectionId: connection.id, modelKey: "model", displayName: "Model",
      contextWindow: 8192, maxOutputTokens: 4096,
      capabilities: { reasoning: true }, defaultSettings: { common: { temperature: 0.1, maxOutputTokens: 4096 }, protocol: {} } }),
    id: modelId, maxInputTokens: null, source: "manual", catalogManaged: false, catalogMetadata: null,
    createdAt: 1, updatedAt: 1
  };
  const agent: AgentDto = {
    id: "agent", name: "Agent", description: "", protected: false, revision: 2, hasAvatar: false,
    modelId, lastSelectedModelId: null, searchApiKeyConfigured: false, userProfile: {},
    firstMessage: "", alternateGreetings: [], roleplayEnabled: false, createdAt: 1, updatedAt: 1,
    execution: agentExecutionConfigSchema.parse({ modelId, contextPolicy: "full", reasoningEffort: "none",
      tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} } }),
    card: characterCardV2Schema.parse({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Agent" } }),
    roleplay: agentRoleplayConfigSchema.parse({})
  };
  const conversation: ConversationDto = {
    id: "conversation", title: "Chat", systemPrompt: "", contextPolicy: "full", modelId, agentId: agent.id,
    executionOverrides: {}, workspacePath: null, draft: "", createdAt: 1, updatedAt: 1
  };
  return { conversation, agent, model, connection,
    userProfile: { displayName: "Global user", description: "Global description" },
    roleplayState: conversationRoleplayStateSchema.parse({}) };
}

describe("generation policy without persistence", () => {
  it("merges model, preset, Agent and conversation parameters without aliasing inputs", () => {
    const input = fixture();
    input.agent.roleplay.enabled = true;
    input.agent.roleplay.presets = [roleplayPresetSchema.parse({ id: "preset", name: "Preset",
      blocks: [{ id: "main", name: "Main", kind: "main", role: "system" }],
      generation: { common: { temperature: 0.2, topP: 0.8 } } })];
    input.agent.execution.generation = { common: { temperature: 0.3, stopSequences: ["END"] } };
    input.agent.execution.tools.overrides = { browser_fetch: true, search_web: true };
    input.agent.userProfile.displayName = "Agent user";
    input.conversation.executionOverrides = {
      generation: { common: { temperature: 0.4, maxOutputTokens: 9000 } }, tools: { search_web: false }
    };
    const before = structuredClone(input);
    const { snapshot } = resolveGenerationPlan(input);
    expect(snapshot.execution.settings.common).toMatchObject({ temperature: 0.4, topP: 0.8, stopSequences: ["END"], maxOutputTokens: 4096 });
    expect(snapshot.execution.tools.overrides).toMatchObject({ browser_fetch: true, search_web: false });
    expect(snapshot.userProfile).toEqual({ displayName: "Agent user", description: "Global description" });
    expect(input).toEqual(before);
    snapshot.card.data.name = "changed snapshot";
    snapshot.execution.settings.common.stopSequences.push("OTHER");
    expect(input).toEqual(before);
  });

  it("preserves explicit empty values and defaults browser access to disabled", () => {
    const input = fixture();
    input.agent.execution.baseSystemPrompt = "";
    input.agent.userProfile.displayName = "";
    const { snapshot } = resolveGenerationPlan({ ...input, generationKind: "regenerate" });
    expect(snapshot).toMatchObject({ baseSystemPrompt: "", userProfile: { displayName: "" }, generationKind: "regenerate" });
    expect(snapshot.execution.tools.overrides.browser_fetch).toBe(false);
    input.conversation.executionOverrides.modelId = null;
    expect(() => resolveGenerationPlan(input)).toThrow("选择模型");
  });

  it("rejects missing Agents, models, disabled models and missing connections", () => {
    const input = fixture();
    expect(() => resolveGenerationPlan({ ...input, conversation: { ...input.conversation, agentId: null } })).toThrow("选择 Agent");
    expect(() => resolveGenerationPlan({ ...input, agent: undefined })).toThrow("Agent 不可用");
    expect(() => resolveGenerationPlan({ ...input, model: undefined })).toThrow("模型不可用");
    expect(() => resolveGenerationPlan({ ...input, model: { ...input.model, enabled: false } })).toThrow("模型不可用");
    expect(() => resolveGenerationPlan({ ...input, connection: undefined })).toThrow("模型不可用");
  });

  it("validates reasoning capabilities and clamps manual thinking budgets", () => {
    const { model } = fixture();
    model.capabilities.reasoning = false;
    expect(() => buildEffectiveSettings(model, "openai-chat", "high")).toThrow("不支持推理强度");
    model.capabilities.reasoning = true;
    model.capabilities.manualThinking = true;
    model.capabilities.adaptiveThinking = false;
    model.maxOutputTokens = 1024;
    expect(() => buildEffectiveSettings(model, "anthropic-messages", "high")).toThrow("输出上限过低");
    model.maxOutputTokens = 4096;
    const settings = buildEffectiveSettings(model, "anthropic-messages", "max");
    expect(settings.resolvedThinkingBudgetTokens).toBeGreaterThanOrEqual(1024);
    expect(settings.resolvedThinkingBudgetTokens).toBeLessThan(settings.common.maxOutputTokens);
  });
});

it("rejects unsupported inherited and explicit efforts before generation, preserving native values", () => {
  const input = fixture();
  input.model = { ...input.model, detectedReasoningEfforts: ["low", "medium", "high", "xhigh"] };
  input.model.catalogMetadata = { providerId: "opencode-go", modelId: "grok-4.6", inputModalities: ["text"], outputModalities: ["text"], reasoningEfforts: ["low", "medium", "high", "xhigh"], fetchedAt: 1 };
  input.agent.execution.reasoningEffort = "max";
  expect(() => resolveGenerationPlan(input)).toThrow("不支持推理强度 max");
  input.conversation.executionOverrides.reasoningEffort = "xhigh";
  expect(resolveGenerationPlan(input).snapshot.execution.settings.reasoningEffort).toBe("xhigh");
  input.conversation.executionOverrides.reasoningEffort = "max";
  expect(() => resolveGenerationPlan(input)).toThrow("low / medium / high / xhigh");
  input.conversation.executionOverrides.reasoningEffort = "none";
  expect(resolveGenerationPlan(input).snapshot.execution.settings.reasoningEffort).toBe("none");
  input.model.catalogMetadata.reasoningEfforts = [];
  input.model = { ...input.model, detectedReasoningEfforts: null };
  input.conversation.executionOverrides.reasoningEffort = "max";
  expect(() => resolveGenerationPlan(input)).toThrow("不支持推理强度");
});

it("keeps default, native none and custom efforts distinct and rejects unknown declarations", () => {
 const { model } = fixture();
 model.reasoningEffortsOverride = ["minimal", "none", "default"];
 for (const value of model.reasoningEffortsOverride) {
  const settings = buildEffectiveSettings(model, "openai-responses", "max", {}, { mode: "effort", value });
  expect(settings.reasoningSelection).toEqual({ mode: "effort", value });
  expect(settings.resolvedThinkingBudgetTokens).toBeUndefined();
 }
 expect(() => buildEffectiveSettings(model, "openai-responses", "none", {}, { mode: "effort", value: "high" })).toThrow("不支持推理强度");
 model.reasoningEffortsOverride = null;
 expect(() => buildEffectiveSettings(model, "openai-responses", "none", {}, { mode: "effort", value: "minimal" })).toThrow();
 expect(buildEffectiveSettings(model, "openai-responses", "max", {}, { mode: "default" }).reasoningSelection).toEqual({ mode: "default" });
 model.capabilities.reasoning = false;
 model.reasoningEffortsOverride = ["high"];
 expect(() => buildEffectiveSettings(model, "openai-responses", "none", {}, { mode: "effort", value: "high" })).toThrow();
});
