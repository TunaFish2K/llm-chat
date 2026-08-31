import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  appSettingsSchema,
  balanceConfigSchema,
  blockTypeSchema,
  commonSettingsSchema,
  connectionInputSchema,
  contextPolicySchema,
  conversationInputSchema,
  generationSettingsSchema,
  generationStatusSchema,
  mcpServerInputSchema,
  mcpServerPatchSchema,
  modelCapabilitiesSchema,
  modelInputSchema,
  modelSettingsSchema,
  patchConversationSchema,
  protocolSchema,
  protocolSettingsSchema,
  reasoningEffortSchema,
  retryGenerationSchema,
  sendMessageSchema,
  startConversationSchema,
  toolApprovalInputSchema,
  toolApprovalStateSchema,
  toolPolicySchema,
  toolSettingsInputSchema
} from "./index";

const uuid = "00000000-0000-4000-8000-000000000001";

describe("contract schemas", () => {
  it("defaults tool directness without changing existing enablement behavior", () => {
    expect(toolPolicySchema.parse({})).toEqual({
      defaultEnabled: true,
      overrides: {},
      directOverrides: {},
      approvalOverrides: {}
    });
    expect(toolPolicySchema.parse({ directOverrides: { search_web: false } }).directOverrides)
      .toEqual({ search_web: false });
  });

  it("accepts every public enum member and rejects unknown values", () => {
    const cases = [
      [protocolSchema, ["openai-responses", "openai-chat", "anthropic-messages"]],
      [contextPolicySchema, ["trim", "summarize", "full"]],
      [generationStatusSchema, ["queued", "running", "waiting-approval", "completed", "stopped", "failed", "interrupted"]],
      [blockTypeSchema, ["text", "reasoning", "refusal", "unsupported"]],
      [reasoningEffortSchema, ["none", "low", "medium", "high", "xhigh", "max"]],
      [toolApprovalStateSchema, ["auto", "pending", "approved", "denied", "running", "completed", "failed"]]
    ] as const;
    for (const [schema, values] of cases) {
      for (const value of values) expect(schema.parse(value)).toBe(value);
      expect(schema.safeParse("unknown").success).toBe(false);
    }
  });

  it("applies settings and capability defaults at valid boundaries", () => {
    expect(commonSettingsSchema.parse({ maxOutputTokens: 1 })).toEqual({ maxOutputTokens: 1, stopSequences: [] });
    expect(commonSettingsSchema.parse({ temperature: 0, topP: 1, maxOutputTokens: 1_000_000, stopSequences: ["x"] }))
      .toMatchObject({ temperature: 0, topP: 1, maxOutputTokens: 1_000_000 });
    expect(modelSettingsSchema.parse({ common: { maxOutputTokens: 1 } }).protocol).toEqual({});
    expect(modelCapabilitiesSchema.parse({})).toEqual({
      tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false,
      adaptiveThinking: false, manualThinking: false
    });
    expect(generationSettingsSchema.parse({ common: { maxOutputTokens: 2 }, reasoningEffort: "high" }))
      .toMatchObject({ protocol: {}, reasoningEffort: "high" });
  });

  it.each([
    [{ maxOutputTokens: 0 }, "zero output"],
    [{ maxOutputTokens: 1.5 }, "fractional output"],
    [{ maxOutputTokens: 1_000_001 }, "excess output"],
    [{ maxOutputTokens: 1, temperature: -0.1 }, "low temperature"],
    [{ maxOutputTokens: 1, temperature: 2.1 }, "high temperature"],
    [{ maxOutputTokens: 1, topP: 1.1 }, "high top-p"],
    [{ maxOutputTokens: 1, stopSequences: Array(9).fill("x") }, "too many stops"],
    [{ maxOutputTokens: 1, stopSequences: [""] }, "empty stop"]
  ])("rejects invalid common settings: %s", (input, _label) => {
    expect(commonSettingsSchema.safeParse(input).success).toBe(false);
  });

  it("validates protocol settings, including historical compatibility fields", () => {
    expect(protocolSettingsSchema.parse({
      reasoningEffort: "minimal", reasoningSummary: "detailed", verbosity: "low",
      thinkingMode: "adaptive", thinkingBudgetTokens: 1024, anthropicEffort: "max"
    })).toBeTruthy();
    for (const input of [
      { reasoningSummary: "verbose" }, { thinkingBudgetTokens: 1023 },
      { thinkingMode: "manual" }, { verbosity: "max" }
    ]) expect(protocolSettingsSchema.safeParse(input).success).toBe(false);
    expect(generationSettingsSchema.safeParse({
      common: { maxOutputTokens: 1 }, reasoningEffort: "none", resolvedThinkingBudgetTokens: 1023
    }).success).toBe(false);
  });

  it("validates connections, URLs, headers, and strips unknown keys", () => {
    const parsed = connectionInputSchema.parse({
      name: "  Local  ", protocol: "openai-chat", baseUrl: "https://example.test/v1",
      secretHeaders: { "X-Key": "secret" }, ignored: true
    });
    expect(parsed).toEqual({
      name: "Local", protocol: "openai-chat", baseUrl: "https://example.test/v1",
      secretHeaders: { "X-Key": "secret" }
    });
    for (const input of [
      { name: "", protocol: "openai-chat", baseUrl: "https://x.test" },
      { name: "x", protocol: "bad", baseUrl: "https://x.test" },
      { name: "x", protocol: "openai-chat", baseUrl: "not a url" },
      { name: "x", protocol: "openai-chat", baseUrl: "https://x.test", apiKey: "x".repeat(4097) },
      { name: "x", protocol: "openai-chat", baseUrl: "https://x.test", secretHeaders: { x: "x".repeat(4097) } }
    ]) expect(connectionInputSchema.safeParse(input).success).toBe(false);
  });

  it("validates optional same-origin balance configuration", () => {
    expect(balanceConfigSchema.parse({
      enabled: true,
      apiPath: "/api/account/balance?currency=usd",
      resultExpression: "data.available / 100"
    })).toEqual({
      enabled: true,
      apiPath: "/api/account/balance?currency=usd",
      resultExpression: "data.available / 100"
    });
    expect(connectionInputSchema.parse({
      name: "No balance", protocol: "openai-chat", baseUrl: "https://x.test"
    }).balanceConfig).toBeUndefined();
    for (const apiPath of ["https://other.test/balance", "//other.test/balance", "balance", "/\\other.test"]) {
      expect(balanceConfigSchema.safeParse({ enabled: true, apiPath, resultExpression: "value" }).success).toBe(false);
    }
    expect(balanceConfigSchema.safeParse({
      enabled: true, apiPath: "/balance", resultExpression: "1".repeat(513)
    }).success).toBe(false);
  });

  it("validates model boundaries and required nested settings", () => {
    const base = {
      connectionId: uuid, modelKey: "model", displayName: "Model", contextWindow: null,
      maxOutputTokens: 1, capabilities: {}, defaultSettings: { common: { maxOutputTokens: 1 } }
    };
    expect(modelInputSchema.parse(base)).toMatchObject({ enabled: true, contextWindow: null });
    for (const patch of [
      { connectionId: "bad" }, { modelKey: " " }, { displayName: "x".repeat(201) },
      { contextWindow: 0 }, { contextWindow: 10_000_001 }, { maxOutputTokens: 0 }
    ]) expect(modelInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("validates app, conversation, send, start, retry, and patch inputs", () => {
    const app = {
      defaultModelId: null, defaultContextPolicy: "trim", theme: "system", defaultSystemPrompt: "",
      reasoningEffort: "none", defaultAgentId: uuid, lastAgentId: uuid,
      userProfile: { displayName: "User", description: "" },
      uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer" },
      lastWorkspacePath: null
    };
    expect(appSettingsSchema.parse(app)).toEqual(app);
    expect(conversationInputSchema.parse({ agentId: uuid })).toEqual({ agentId: uuid, executionOverrides: {}, workspacePath: null });
    expect(sendMessageSchema.parse({ text: "  hello  ", extra: 1 })).toEqual({ text: "hello" });
    expect(startConversationSchema.parse({ text: "hello", agentId: uuid })).toEqual({
      text: "hello", agentId: uuid, greetingIndex: 0, executionOverrides: {}, workspacePath: null
    });
    expect(retryGenerationSchema.parse({ ignored: true })).toEqual({});
    expect(patchConversationSchema.parse({ agentId: null, draft: "", ignored: true })).toEqual({ agentId: null, draft: "" });
    expect(patchConversationSchema.parse({ title: "Renamed" })).toEqual({ title: "Renamed" });
    for (const input of [{ text: " " }, { text: "x".repeat(1_000_001) }]) {
      expect(sendMessageSchema.safeParse(input).success).toBe(false);
    }
    expect(startConversationSchema.safeParse({ text: "x", agentId: "bad" }).success).toBe(false);
    expect(patchConversationSchema.safeParse({ executionOverrides: { contextPolicy: "recent" } }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ...app, theme: "blue" }).success).toBe(false);
  });

  it("validates approval, tool settings, MCP settings, and API errors", () => {
    expect(toolApprovalInputSchema.parse({ approved: false, reason: "no" })).toEqual({ approved: false, reason: "no" });
    expect(toolApprovalInputSchema.safeParse({ approved: "yes" }).success).toBe(false);
    expect(toolApprovalInputSchema.safeParse({ approved: true, reason: "x".repeat(2001) }).success).toBe(false);
    expect(toolSettingsInputSchema.parse({ search: { baseUrl: "" } })).toEqual({ search: { baseUrl: "" } });
    expect(toolSettingsInputSchema.safeParse({ search: { baseUrl: "bad" } }).success).toBe(false);
    expect(toolSettingsInputSchema.safeParse({ enabled: { tool: "yes" } }).success).toBe(false);
    expect(mcpServerInputSchema.parse({ name: "Server1", url: "https://mcp.test" }))
      .toEqual({ name: "Server1", url: "https://mcp.test", headers: {}, enabled: true });
    expect(mcpServerPatchSchema.parse({ name: "Server2" })).toEqual({ name: "Server2" });
    expect(mcpServerPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(mcpServerPatchSchema.parse({ headers: {} })).toEqual({ headers: {} });
    for (const input of [
      { name: "with-dash", url: "https://mcp.test" }, { name: "Server", url: "bad" },
      { name: "Server", url: "https://mcp.test", headers: { Authorization: "x".repeat(4097) } }
    ]) expect(mcpServerInputSchema.safeParse(input).success).toBe(false);
    expect(mcpServerPatchSchema.safeParse({ name: "with-dash" }).success).toBe(false);
    expect(apiErrorSchema.parse({ error: { code: "bad", message: "failed", details: { id: 1 } } }))
      .toMatchObject({ error: { code: "bad", message: "failed" } });
    expect(apiErrorSchema.safeParse({ error: { code: "bad" } }).success).toBe(false);
  });
});
