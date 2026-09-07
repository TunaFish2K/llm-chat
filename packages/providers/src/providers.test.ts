import type { GenerationSettings } from "@llm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "./anthropic";
import { endpoint, ensureOk, headers, listModelEndpoint, readSse } from "./http";
import { adapterFor } from "./index";
import { OpenAiChatAdapter } from "./openai-chat";
import { OpenAiResponsesAdapter } from "./openai-responses";
import { ProviderError, type GenerateRequest, type ProviderConnection, type ProviderEvent } from "./types";

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

  it("builds protocol authentication headers and lets configured headers override defaults", () => {
    const openai = request("openai-chat").connection;
    expect(headers(openai)).toEqual({ "content-type": "application/json", authorization: "Bearer key" });
    const anthropic = request("anthropic-messages").connection;
    anthropic.secretHeaders = { "anthropic-version": "custom", "x-extra": "value" };
    expect(headers(anthropic)).toEqual({
      "content-type": "application/json", "x-api-key": "key", "anthropic-version": "custom", "x-extra": "value"
    });
    expect(headers({ ...openai, apiKey: "", secretHeaders: {} })).toEqual({ "content-type": "application/json" });
    expect(endpoint("https://example.test/v1/models", "/models")).toBe("https://example.test/v1/models");
  });

  it("adds OpenCode Go request identity headers and reserves their values", () => {
    const connection = {
      ...request("openai-chat").connection,
      providerId: "opencode-go" as const,
      secretHeaders: {
        "x-opencode-session": "spoofed",
        "x-opencode-request": "spoofed",
        "x-opencode-client": "spoofed",
        "User-Agent": "spoofed"
      }
    };
    expect(headers(connection, {
      sessionId: "ses_conversation",
      requestId: "generation:step-0",
      clientId: "llm-chat",
      userAgent: "llm-chat/0.1.0"
    })).toMatchObject({
      "x-opencode-session": "ses_conversation",
      "x-opencode-request": "generation:step-0",
      "x-opencode-client": "llm-chat",
      "User-Agent": "llm-chat/0.1.0"
    });
  });

  it.each([
    [401, { error: { message: "bad key" } }, "provider_auth_error"],
    [403, { error: "forbidden" }, "provider_auth_error"],
    [429, { error: { message: "slow down" } }, "provider_rate_limit"],
    [500, "<html>private upstream page</html>", "provider_http_error"]
  ])("normalizes non-OK HTTP %i without leaking unstructured bodies", async (status, body, code) => {
    const response = typeof body === "string"
      ? new Response(body, { status, headers: { "x-request-id": "req-1" } })
      : Response.json(body, { status, headers: { "request-id": "req-1" } });
    const error = await ensureOk(response).catch((caught) => caught) as ProviderError;
    expect(error).toMatchObject({ name: "ProviderError", code, status });
    expect(error.message).toContain("req-1");
    if (status === 500) expect(error.message).not.toContain("private upstream page");
  });

  it("lists and normalizes both model response shapes and forwards abort signals", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json({ data: [
      { id: "a", display_name: "Model A" }, { id: "b", displayName: "Model B" }, { nope: true }
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listModelEndpoint(request("openai-chat").connection, controller.signal)).resolves.toEqual([
      { id: "a", displayName: "Model A" }, { id: "b", displayName: "Model B" }
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/v1/models", expect.objectContaining({ signal: controller.signal }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [{ id: "c", name: "Model C" }, { id: "d" }] })));
    await expect(listModelEndpoint(request("anthropic-messages").connection)).resolves.toEqual([
      { id: "c", displayName: "Model C" }, { id: "d", displayName: "d" }
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "no" }, { status: 403 })));
    await expect(listModelEndpoint(request("openai-chat").connection)).rejects.toMatchObject({ code: "provider_auth_error" });
  });

  it("ignores SSE comments and empty frames, defaults event names, and wraps read failures", async () => {
    const events = [];
    for await (const event of readSse(streamResponse([": keepalive\n\n", "data: value\n\n", "event: empty\n\n"]))) events.push(event);
    expect(events).toEqual([{ event: "message", data: "value" }]);
    await expect(collectSse(new Response(null))).rejects.toMatchObject({ code: "provider_stream_error" });
    const failed = new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket failed")); } }));
    await expect(collectSse(failed)).rejects.toMatchObject({ code: "provider_stream_error", message: "socket failed" });
    const aborted = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("aborted", "AbortError")); } }));
    await expect(collectSse(aborted)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("provider adapters", () => {
  it("maps image inputs into each provider's native multimodal format", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/responses")) {
        return streamResponse([namedFrame("response.completed", { response: {} })]);
      }
      if (url.endsWith("/messages")) {
        return streamResponse([namedFrame("message_stop", {})]);
      }
      return streamResponse(["data: [DONE]\n\n"]);
    }));
    const image = { mimeType: "image/png" as const, dataBase64: "aW1hZ2U=", fileName: "image.png" };

    for (const [protocol, adapter] of [
      ["openai-chat", new OpenAiChatAdapter()],
      ["openai-responses", new OpenAiResponsesAdapter()],
      ["anthropic-messages", new AnthropicAdapter()]
    ] as const) {
      const req = request(protocol);
      req.messages = [{ role: "user", text: "describe", images: [image] }];
      req.capabilities.imageInput = true;
      await collect(adapter.stream(req));
    }

    const chatMessages = bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(chatMessages.at(-1)?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "auto" } },
      { type: "text", text: "describe" }
    ]);
    const responsesInput = bodies[1]!.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(responsesInput[0]?.content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "auto" },
      { type: "input_text", text: "describe" }
    ]);
    const anthropicMessages = bodies[2]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(anthropicMessages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "text", text: "describe" }
    ]);
  });

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

  it("normalizes Chat cache usage across official and vendor dialects", async () => {
    const rawUsages = [
      {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 3 },
        cached_tokens: 4,
        prompt_cache_hit_tokens: 5
      },
      { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 0, prompt_cache_hit_tokens: 5 },
      { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 2 },
      { prompt_tokens: 10, completion_tokens: 2 }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      frame({ choices: [], usage: rawUsages.shift() }),
      "data: [DONE]\n\n"
    ])));

    for (const expected of [
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 },
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 2 },
      { inputTokens: 10, outputTokens: 2 }
    ]) {
      const events = await collect(new OpenAiChatAdapter().stream(request("openai-chat")));
      expect(events).toContainEqual({ type: "usage", usage: expected });
    }
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
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } });
    expect(events).toContainEqual({ type: "provider-context", payload: expect.arrayContaining([expect.objectContaining({ signature: "sig" })]) });
  });

  it("maps Chat settings and message variants and tolerates malformed chunks", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return streamResponse([
        "data: not-json\n\n",
        frame({ choices: [{ delta: { reasoning: "why", refusal: "cannot" } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ function: { name: "missing_id" } }] } }] }),
        frame({ choices: [], usage: { completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }),
        "data: [DONE]\n\n"
      ]);
    }));
    const req = request("openai-chat");
    req.settings = {
      common: { maxOutputTokens: 33, temperature: 0, topP: 0.5, stopSequences: ["END"] },
      protocol: {}, reasoningEffort: "low"
    };
    req.messages = [
      { role: "assistant", text: "", toolCalls: [{ id: "old", name: "fn", arguments: "{}" }] },
      { role: "tool", text: "", toolResults: [{ callId: "old", name: "fn", content: "ok" }] }
    ];
    const events = await collect(new OpenAiChatAdapter().stream(req));
    expect(body).toMatchObject({
      max_completion_tokens: 33, temperature: 0, top_p: 0.5, stop: ["END"], reasoning_effort: "low"
    });
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "system" }), expect.objectContaining({ role: "assistant", content: null }),
      expect.objectContaining({ role: "tool", tool_call_id: "old" })
    ]));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "refusal", content: "cannot", complete: true }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 4, outputTokens: 3, reasoningTokens: 2, totalTokens: 7 } });
    expect(events.some((event) => event.type === "tool-call" && event.call.name === "missing_id")).toBe(false);
  });

  it("maps Responses refusal, unsupported items, usage details, stop reasons, and failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      "data: malformed\n\n",
      namedFrame("response.refusal.delta", { delta: "denied" }),
      namedFrame("response.output_item.done", { item: { type: "computer_call", id: "u1" } }),
      namedFrame("response.output_item.done", { item: { type: "function_call", id: "fallback", name: "fn", arguments: 3 } }),
      namedFrame("response.completed", { response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } }
      } })
    ])));
    const events = await collect(new OpenAiResponsesAdapter().stream(request("openai-responses")));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "refusal", content: "denied", complete: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "unsupported", providerPayload: { type: "computer_call", id: "u1" } }));
    expect(events).toContainEqual({ type: "tool-call", call: { id: "fallback", name: "fn", arguments: "{}" } });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 8, outputTokens: 5, reasoningTokens: 1, cachedInputTokens: 2, totalTokens: 13 } });
    expect(events.at(-1)).toEqual({ type: "complete", stopReason: "max_output_tokens" });

    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([namedFrame("response.failed", { response: { error: { message: "generation failed" } } })])));
    await expect(collect(new OpenAiResponsesAdapter().stream(request("openai-responses")))).rejects.toThrow("generation failed");
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([namedFrame("response.failed", { response: {} })])));
    await expect(collect(new OpenAiResponsesAdapter().stream(request("openai-responses")))).rejects.toThrow("Responses 生成失败");
  });

  it("preserves zero and missing Responses cache usage", async () => {
    const rawUsages = [
      { input_tokens: 4, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
      { input_tokens: 4, output_tokens: 1, input_tokens_details: {} }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      namedFrame("response.completed", { response: { usage: rawUsages.shift() } })
    ])));

    const withZero = await collect(new OpenAiResponsesAdapter().stream(request("openai-responses")));
    expect(withZero).toContainEqual({
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: 0 }
    });
    const withoutCache = await collect(new OpenAiResponsesAdapter().stream(request("openai-responses")));
    expect(withoutCache).toContainEqual({ type: "usage", usage: { inputTokens: 4, outputTokens: 1 } });
  });

  it("does not replay provider context across connections", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return streamResponse([namedFrame("response.completed", { response: {} })]);
    }));
    const req = request("openai-responses");
    req.messages = [{
      role: "assistant", text: "visible", providerConnectionId: "other",
      providerPayload: [{ type: "reasoning", encrypted_content: "secret" }]
    }];
    await collect(new OpenAiResponsesAdapter().stream(req));
    expect(JSON.stringify(body.input)).not.toContain("secret");
    expect(body.input).toEqual([{ role: "assistant", content: [{ type: "output_text", text: "visible" }] }]);
  });

  it("normalizes Anthropic redacted and unsupported blocks and malformed tool JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      "data: not-json\n\n",
      namedFrame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }),
      namedFrame("content_block_stop", { index: 0 }),
      namedFrame("content_block_start", { index: 1, content_block: { type: "image", source: "x" } }),
      namedFrame("content_block_stop", { index: 1 }),
      namedFrame("content_block_start", { index: 2, content_block: { type: "tool_use", id: "tool", name: "fn" } }),
      namedFrame("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{" } }),
      namedFrame("content_block_stop", { index: 2 }),
      namedFrame("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4, cache_read_input_tokens: 2 } })
    ])));
    const events = await collect(new AnthropicAdapter().stream(request("anthropic-messages")));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "reasoning", content: "[推理内容已由提供方隐藏]", complete: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "block", blockType: "unsupported", content: expect.stringContaining("image") }));
    expect(events).toContainEqual({ type: "tool-call", call: { id: "tool", name: "fn", arguments: "{}" } });
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 4, cachedInputTokens: 2, totalTokens: 6 }
    });
    expect(events.at(-1)).toEqual({ type: "complete", stopReason: "max_tokens" });
  });

  it("normalizes Anthropic cache creation and reads across split usage events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      namedFrame("message_start", { message: { usage: {
        input_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 1
      } } }),
      namedFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })
    ])));

    const events = await collect(new AnthropicAdapter().stream(request("anthropic-messages")));
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2, totalTokens: 17 }
    });
  });

  it("preserves explicit zero Anthropic cache usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      namedFrame("message_start", { message: { usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0
      } } }),
      namedFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })
    ])));

    const events = await collect(new AnthropicAdapter().stream(request("anthropic-messages")));
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }
    });
  });

  it("maps Anthropic request settings, avoids duplicate tool blocks, and surfaces protocol errors", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return streamResponse([namedFrame("message_stop", {})]);
    }));
    const req = request("anthropic-messages");
    req.settings = {
      common: { maxOutputTokens: 100, temperature: 0, topP: 0.2, stopSequences: ["END"] },
      protocol: {}, reasoningEffort: "none"
    };
    req.messages = [{
      role: "assistant", text: "ignored", providerConnectionId: req.connection.id,
      providerPayload: [{ type: "tool_use", id: "same", name: "fn", input: {} }],
      toolCalls: [{ id: "same", name: "fn", arguments: "{" }, { id: "new", name: "new_fn", arguments: "{" }]
    }, { role: "tool", text: "", toolResults: [{ callId: "new", name: "new_fn", content: "bad", isError: true }] }];
    await collect(new AnthropicAdapter().stream(req));
    expect(body).toMatchObject({ max_tokens: 100, temperature: 0, top_p: 0.2, stop_sequences: ["END"] });
    expect(JSON.stringify(body.messages).match(/\"id\":\"same\"/g)).toHaveLength(1);
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [expect.objectContaining({ is_error: true })] })
    ]));

    const missing = request("anthropic-messages");
    missing.capabilities = { ...missing.capabilities, adaptiveThinking: false, manualThinking: true };
    missing.settings = { ...settings, reasoningEffort: "high" };
    await expect(collect(new AnthropicAdapter().stream(missing))).rejects.toMatchObject({ code: "reasoning_budget_missing" });
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([namedFrame("error", { error: { message: "anthropic failed" } })])));
    await expect(collect(new AnthropicAdapter().stream(request("anthropic-messages")))).rejects.toThrow("anthropic failed");
  });

  it("propagates HTTP and abort failures and returns the registered adapter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "upstream" } }, { status: 500 })));
    await expect(collect(new OpenAiChatAdapter().stream(request("openai-chat")))).rejects.toMatchObject({ code: "provider_http_error" });
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    const req = request("openai-responses");
    req.signal = controller.signal;
    await expect(collect(new OpenAiResponsesAdapter().stream(req))).rejects.toMatchObject({ name: "AbortError" });
    expect(adapterFor("openai-chat")).toBeInstanceOf(OpenAiChatAdapter);
    expect(adapterFor("openai-responses")).toBeInstanceOf(OpenAiResponsesAdapter);
    expect(adapterFor("anthropic-messages")).toBeInstanceOf(AnthropicAdapter);
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
    connection: { id: "connection", providerId: "custom", protocol, baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {} },
    modelKey: "model",
    systemPrompt: "system",
    messages: [{ role: "user", text: "hello" }],
    settings,
    capabilities: {
      imageInput: false,
      tools: true,
      temperature: true,
      topP: true,
      reasoning: true,
      reasoningSummary: protocol === "openai-responses",
      adaptiveThinking: protocol === "anthropic-messages",
      manualThinking: protocol === "anthropic-messages"
    },
    requestContext: {
      sessionId: "ses_test",
      requestId: "req_test",
      clientId: "llm-chat",
      userAgent: "llm-chat/test"
    },
    signal: new AbortController().signal
  };
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function collectSse(response: Response): Promise<Array<{ event: string; data: string }>> {
  const events = [];
  for await (const event of readSse(response)) events.push(event);
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
