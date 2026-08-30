import type { GenerationSettings } from "@llm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "./anthropic";
import { endpoint, readSse } from "./http";
import { OpenAiChatAdapter } from "./openai-chat";
import { OpenAiResponsesAdapter } from "./openai-responses";
import type { GenerateRequest, ProviderConnection, ProviderEvent } from "./types";

const settings: GenerationSettings = {
  common: { maxOutputTokens: 256, stopSequences: [] },
  protocol: {},
  reasoningEffort: "none"
};

afterEach(() => vi.unstubAllGlobals());

describe("provider HTTP helpers", () => {
  it("builds resources below a v1 base URL", () => {
    expect(endpoint("https://example.test/v1/", "responses")).toBe("https://example.test/v1/responses");
    expect(endpoint("https://example.test", "models")).toBe("https://example.test/v1/models");
  });

  it("parses fragmented multi-line SSE frames", async () => {
    const response = streamResponse(["event: ping\nda", "ta: one\ndata: two\n\n"]);
    const events = [];
    for await (const event of readSse(response)) events.push(event);
    expect(events).toEqual([{ event: "ping", data: "one\ntwo" }]);
  });
});

describe("provider adapters", () => {
  it("sends and reconstructs streamed Chat Completions tool calls", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_", arguments: "{\"" } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "time_info", arguments: "zone\":\"UTC\"}" } }] }, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n"
      ]);
    }));
    const req = request("openai-chat");
    req.tools = [{ name: "get_time_info", description: "Get time", inputSchema: { type: "object", properties: {} } }];
    const events = await collect(new OpenAiChatAdapter().stream(req));
    expect(sentBody?.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "get_time_info" }) })]);
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call_1", name: "get_time_info", arguments: "{\"zone\":\"UTC\"}" } });
  });

  it("sends Responses tool outputs and parses function calls", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        namedFrame("response.output_item.done", { item: { type: "function_call", call_id: "call_2", name: "search_web", arguments: "{\"query\":\"news\"}" } }),
        namedFrame("response.completed", { response: {} })
      ]);
    }));
    const req = request("openai-responses");
    req.messages = [
      { role: "assistant", text: "", toolCalls: [{ id: "old", name: "get_time_info", arguments: "{}" }] },
      { role: "tool", text: "", toolResults: [{ callId: "old", name: "get_time_info", content: "ok" }] }
    ];
    req.tools = [{ name: "search_web", description: "Search", inputSchema: { type: "object", properties: {} } }];
    const events = await collect(new OpenAiResponsesAdapter().stream(req));
    expect(sentBody?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "old" }),
      expect.objectContaining({ type: "function_call_output", call_id: "old", output: "ok" })
    ]));
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call_2", name: "search_web", arguments: "{\"query\":\"news\"}" } });
  });

  it("sends Anthropic tool results and parses tool_use JSON deltas", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        namedFrame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_time_info", input: {} } }),
        namedFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"zone\":\"UTC\"}" } }),
        namedFrame("content_block_stop", { index: 0 }),
        namedFrame("message_delta", { delta: { stop_reason: "tool_use" }, usage: {} }),
        namedFrame("message_stop", {})
      ]);
    }));
    const req = request("anthropic-messages");
    req.messages = [
      { role: "assistant", text: "", toolCalls: [{ id: "old", name: "get_time_info", arguments: "{}" }] },
      { role: "tool", text: "", toolResults: [{ callId: "old", name: "get_time_info", content: "ok" }] }
    ];
    req.tools = [{ name: "get_time_info", description: "Get time", inputSchema: { type: "object", properties: {} } }];
    const events = await collect(new AnthropicAdapter().stream(req));
    expect(sentBody?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "old" })]) }),
      expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "old" })]) })
    ]));
    expect(events).toContainEqual({ type: "tool-call", call: { id: "toolu_1", name: "get_time_info", arguments: "{\"zone\":\"UTC\"}" } });
  });

  it("normalizes Chat Completions text, reasoning, usage, and stop reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      frame({ choices: [{ delta: { reasoning_content: "想" } }] }),
      frame({ choices: [{ delta: { content: "你好" }, finish_reason: "stop" }] }),
      frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }),
      "data: [DONE]\n\n"
    ])));
    const events = await collect(new OpenAiChatAdapter().stream(request("openai-chat")));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "reasoning", content: "想", complete: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "text", content: "你好", complete: true }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } });
    expect(events.at(-1)).toEqual({ type: "complete", stopReason: "stop" });
  });

  it("returns Responses reasoning items to the same connection", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        namedFrame("response.reasoning_summary_text.delta", { delta: "摘要" }),
        namedFrame("response.output_text.delta", { delta: "答案" }),
        namedFrame("response.output_item.done", { item: { type: "reasoning", id: "r1", encrypted_content: "opaque" } }),
        namedFrame("response.completed", { response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })
      ]);
    }));
    const req = request("openai-responses");
    req.messages = [{
      role: "assistant",
      text: "旧答案",
      providerConnectionId: req.connection.id,
      providerPayload: [{ type: "reasoning", id: "old", encrypted_content: "secret" }]
    }, { role: "user", text: "继续" }];
    const events = await collect(new OpenAiResponsesAdapter().stream(req));
    expect(sentBody?.input).toEqual(expect.arrayContaining([expect.objectContaining({ id: "old" })]));
    expect(events).toContainEqual({ type: "provider-context", payload: [{ type: "reasoning", id: "r1", encrypted_content: "opaque" }] });
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "text", content: "答案", complete: true }));
  });

  it("preserves Anthropic thinking signatures and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      namedFrame("message_start", { message: { usage: { input_tokens: 7 } } }),
      namedFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      namedFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "分析" } }),
      namedFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      namedFrame("content_block_stop", { index: 0 }),
      namedFrame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      namedFrame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "结果" } }),
      namedFrame("content_block_stop", { index: 1 }),
      namedFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      namedFrame("message_stop", {})
    ])));
    const events = await collect(new AnthropicAdapter().stream(request("anthropic-messages")));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "reasoning", content: "分析", complete: true }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 7, outputTokens: 5 } });
    expect(events).toContainEqual({ type: "provider-context", payload: expect.arrayContaining([expect.objectContaining({ signature: "sig" })]) });
  });
});

describe("unified reasoningEffort mapping", () => {
  it("openai-responses sends every enabled effort unchanged", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse([namedFrame("response.completed", { response: {} })]);
    }));
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const req = request("openai-responses");
      req.settings = { ...settings, reasoningEffort: effort };
      await collect(new OpenAiResponsesAdapter().stream(req));
    }
    const efforts = seen.map((body) => (body.reasoning as Record<string, unknown> | undefined)?.effort);
    expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const req = request("openai-responses");
    req.settings = { ...settings, reasoningEffort: "none" };
    await collect(new OpenAiResponsesAdapter().stream(req));
    expect(seen.at(-1)!.reasoning).toBeUndefined();
  });

  it("openai-responses includes reasoningSummary only when effort engaged", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse([namedFrame("response.completed", { response: {} })]);
    }));
    const withSummary: GenerationSettings = {
      common: { maxOutputTokens: 256, stopSequences: [] },
      protocol: { reasoningSummary: "detailed" },
      reasoningEffort: "medium"
    };
    const req = request("openai-responses");
    req.settings = withSummary;
    await collect(new OpenAiResponsesAdapter().stream(req));
    expect((seen.at(-1)!.reasoning as Record<string, unknown>).summary).toBe("detailed");
    req.settings = { ...withSummary, reasoningEffort: "none" };
    await collect(new OpenAiResponsesAdapter().stream(req));
    expect(seen.at(-1)!.reasoning).toBeUndefined();
  });

  it("openai-chat sends every enabled effort unchanged and omits none", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse(["data: [DONE]\n\n"]);
    }));
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const req = request("openai-chat");
      req.settings = { ...settings, reasoningEffort: effort };
      await collect(new OpenAiChatAdapter().stream(req));
    }
    expect(seen.map((body) => body.reasoning_effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const req = request("openai-chat");
    req.settings = { ...settings, reasoningEffort: "none" };
    await collect(new OpenAiChatAdapter().stream(req));
    expect(seen.at(-1)!.reasoning_effort).toBeUndefined();
  });

  it("anthropic adaptiveThinking sends adaptive + output_config.effort", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([namedFrame("message_stop", {})]);
    }));
    const req = request("anthropic-messages");
    req.settings = { ...settings, reasoningEffort: "high" };
    await collect(new AnthropicAdapter().stream(req));
    expect(sent!.thinking).toEqual({ type: "adaptive" });
    expect(sent!.output_config).toEqual({ effort: "high" });
  });

  it("anthropic manual-only sends enabled budget and no output_config", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([namedFrame("message_stop", {})]);
    }));
    const req = request("anthropic-messages");
    req.capabilities = { ...req.capabilities, adaptiveThinking: false, manualThinking: true };
    req.settings = {
      common: { maxOutputTokens: 4096, stopSequences: [] },
      protocol: {},
      reasoningEffort: "high",
      resolvedThinkingBudgetTokens: Math.floor(4096 * 0.55)
    };
    await collect(new AnthropicAdapter().stream(req));
    expect(sent!.output_config).toBeUndefined();
    expect(sent!.thinking).toEqual({ type: "enabled", budget_tokens: Math.floor(4096 * 0.55) });
  });

  it("anthropic manual-only honours thinkingBudgetTokens anchor for medium", async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([namedFrame("message_stop", {})]);
    }));
    const req = request("anthropic-messages");
    req.capabilities = { ...req.capabilities, adaptiveThinking: false, manualThinking: true };
    req.settings = {
      common: { maxOutputTokens: 8192, stopSequences: [] },
      protocol: { thinkingBudgetTokens: 2048 },
      reasoningEffort: "medium",
      resolvedThinkingBudgetTokens: 2048
    };
    await collect(new AnthropicAdapter().stream(req));
    expect(sent!.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("capabilities.reasoning=false strips reasoning fields entirely", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse([namedFrame("response.completed", { response: {} })]);
    }));
    const req = request("openai-responses");
    req.capabilities = { ...req.capabilities, reasoning: false };
    req.settings = { ...settings, reasoningEffort: "high" };
    await collect(new OpenAiResponsesAdapter().stream(req));
    expect(seen.at(-1)!.reasoning).toBeUndefined();
  });
});

function request(protocol: ProviderConnection["protocol"]): GenerateRequest {
  return {
    connection: { id: "connection", protocol, baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {} },
    modelKey: "model",
    systemPrompt: "system",
    messages: [{ role: "user", text: "hello" }],
    settings,
    capabilities: {
      tools: true,
      temperature: true,
      topP: true,
      reasoning: true,
      reasoningSummary: protocol === "openai-responses",
      adaptiveThinking: protocol === "anthropic-messages",
      manualThinking: protocol === "anthropic-messages"
    },
    signal: new AbortController().signal
  };
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function frame(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function namedFrame(type: string, value: Record<string, unknown>): string { return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`; }
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
