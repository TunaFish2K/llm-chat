import type { ConnectionDto } from "@llm-chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { ModelCatalogService } from "./model-catalog";

const connection: ConnectionDto = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "OpenAI proxy",
  providerId: "custom",
  protocol: "openai-responses",
  baseUrl: "https://proxy.example/v1",
  hasApiKey: true,
  secretHeaderNames: [],
  createdAt: 1,
  updatedAt: 1
};

describe("ModelCatalogService", () => {
  it("matches official providers, maps declared limits and reuses the cached index", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      other: { models: { "gpt-5.4": { name: "Wrong duplicate", limit: { context: 1_000, output: 100 } } } },
      openai: {
        models: {
          "gpt-5.4": {
            name: "GPT-5.4",
            family: "gpt-5",
            release_date: "2026-03-01",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high", "xhigh"] }],
            tool_call: true,
            temperature: false,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_050_000, input: 1_000_000, output: 50_000 },
            cost: { input: 2.5, output: 15, cache_read: 0.25 }
          },
          "gpt-chat": {
            name: "GPT Chat",
            reasoning: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_384 }
          }
        }
      }
    }))) as unknown as typeof fetch;
    const service = new ModelCatalogService(fetchImpl);
    const first = await service.enrich(connection, [{ id: "openai/gpt-5.4", displayName: "gpt-5.4" }]);
    const second = await service.enrich(connection, [{ id: "gpt-5.4", displayName: "GPT 5.4" }]);
    const chat = await service.enrich(connection, [{ id: "gpt-chat", displayName: "GPT Chat" }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.models[0]).toMatchObject({
      matched: true,
      input: {
        contextWindow: 1_050_000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 50_000,
        capabilities: { imageInput: true, tools: true, temperature: false, reasoning: true },
        defaultSettings: { common: { maxOutputTokens: 4_096 } }
      },
      catalogMetadata: {
        providerId: "openai",
        family: "gpt-5",
        reasoningEfforts: ["low", "high", "xhigh"],
        pricing: { input: 2.5, output: 15, cacheRead: 0.25 }
      }
    });
    expect(second.models[0]?.matched).toBe(true);
    expect(chat.models[0]?.input.capabilities.reasoning).toBe(false);
  });

  it("falls back safely when the directory is unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const result = await new ModelCatalogService(fetchImpl).enrich(connection, [{ id: "unknown", displayName: "Unknown" }]);
    expect(result.warning).toContain("暂时不可用");
    expect(result.models[0]).toMatchObject({
      matched: false,
      input: { contextWindow: null, maxInputTokens: null, maxOutputTokens: 4_096 }
    });
  });
});

 it("detects exact SDK overrides, keeps official Go endpoints and infers custom relays by vendor", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    other: { models: { unknown: { provider: { npm: "@ai-sdk/anthropic" } } } },
    "opencode-go": { npm: "@ai-sdk/openai-compatible", models: {
      "grok-4.6": {},
      "minimax-m3": { provider: { npm: "@ai-sdk/anthropic" } },
      "glm-5.3": {},
      "qwen3.8-max": {}
    } }
  }))) as unknown as typeof fetch;
  const go = { ...connection, providerId: "opencode-go" as const, protocol: "openai-chat" as const };
  const ids = ["grok-4.6", "minimax-m3", "glm-5.3", "qwen3.8-max", "unknown"];
  const result = await new ModelCatalogService(fetchImpl).enrich(go, ids.map(id => ({ id, displayName: id })));
  expect(result.models.map(m => m.input.detectedProtocol)).toEqual(["openai-responses", "anthropic-messages", "openai-chat", "anthropic-messages", null]);
  const customIds = ["claude-sonnet-4-5", "anthropic/claude-opus-4", "gpt-5.4", "o3-mini", "glm-5.3", "grok-4.6", "mystery"];
  const custom = await new ModelCatalogService(fetchImpl).enrich(connection, customIds.map(id => ({ id, displayName: id })));
  expect(custom.models.map(m => m.input.detectedProtocol)).toEqual([
    "anthropic-messages", "anthropic-messages", "openai-responses", "openai-responses", "openai-chat", "openai-chat", "openai-chat"
  ]);
  const offline = await new ModelCatalogService(async () => { throw new Error("offline"); }).enrich(go, [{ id: "grok-4.6", displayName: "Grok" }]);
  expect(offline.models[0]?.input.detectedProtocol).toBe("openai-responses");
  const offlineCustom = await new ModelCatalogService(async () => { throw new Error("offline"); }).enrich(connection, [{ id: "claude-haiku-4-5", displayName: "Claude" }]);
  expect(offlineCustom.models[0]?.input.detectedProtocol).toBe("anthropic-messages");
 });

 it("reads the provider-level SDK for preset connections", async () => {
  const service = new ModelCatalogService(async () => new Response(JSON.stringify({
    openai: { npm: "@ai-sdk/openai", models: { "gpt-5.4": {} } },
    deepseek: { npm: "@ai-sdk/openai-compatible", models: { "deepseek-chat": {} } }
  })));
  const openai = { ...connection, providerId: "openai" as const, protocol: "openai-chat" as const };
  expect((await service.enrich(openai, [{ id: "gpt-5.4", displayName: "GPT" }])).models[0]?.input.detectedProtocol).toBe("openai-responses");
  const deepseek = { ...connection, providerId: "deepseek" as const, protocol: "openai-chat" as const };
  expect((await service.enrich(deepseek, [{ id: "deepseek-chat", displayName: "DeepSeek" }])).models[0]?.input.detectedProtocol).toBe("openai-chat");
 });

it("keeps native values including minimal and uses fuzzy matches when no exact entry exists", async () => {
 const service = new ModelCatalogService(async () => new Response(JSON.stringify({
  "opencode-go": { models: { "grok-4.6": { reasoning_options: [{ type: "effort", values: ["minimal", "none", "default", "minimal", null, ""] }] } } },
  anthropic: { models: { "claude-haiku-4-5": { reasoning_options: [{ type: "budget_tokens", min: 1024 }] } } }
 })));
 const go = { ...connection, providerId: "opencode-go" as const };
 expect((await service.enrich(go, [{ id: "grok-4.6", displayName: "Grok" }])).models[0]?.input.detectedReasoningEfforts).toEqual(["minimal", "none", "default"]);
 expect((await service.enrich(connection, [{ id: "grok-4.6", displayName: "Grok" }])).models[0]?.input.detectedReasoningEfforts).toEqual(["minimal", "none", "default"]);
 expect((await service.enrich(connection, [{ id: "claude-haiku-4-5", displayName: "Claude" }])).models[0]?.input.detectedReasoningEfforts).toBeNull();
});
