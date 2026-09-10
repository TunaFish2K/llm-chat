import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFor, estimateMessageTokens, prepareMessages, projectMessages, type GenerateRequest, type ProviderEvent } from "./index";

const protocols = ["openai-chat", "openai-responses", "anthropic-messages"] as const;
function request(protocol: typeof protocols[number]): GenerateRequest {
  return {
    connection: { id: "connection", providerId: "custom", protocol, baseUrl: "https://example.test", apiKey: "", secretHeaders: {} },
    modelKey: "model", systemPrompt: "", messages: [{ role: "user", text: "hello" }],
    settings: { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {}, reasoningEffort: "none" },
    capabilities: { imageInput: true, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
    requestContext: { sessionId: "test", requestId: "test", clientId: "test", userAgent: "test" }, signal: new AbortController().signal
  };
}
function frame(data: unknown) { return `data: ${JSON.stringify(data)}\n\n`; }
const terminal = { "openai-chat": "data: [DONE]\n\n", "openai-responses": frame({ type: "response.completed", response: {} }), "anthropic-messages": frame({ type: "message_stop" }) };
function textFrame(protocol: typeof protocols[number]) {
  return protocol === "openai-chat" ? frame({ choices: [{ delta: { content: "partial" } }] })
    : protocol === "openai-responses" ? frame({ type: "response.output_text.delta", delta: "partial" })
    : frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } });
}
async function collect(req: GenerateRequest, output: ProviderEvent[] = []) {
  for await (const event of adapterFor(req.connection.protocol).stream(req)) output.push(event);
  return output;
}
afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)("%s request and stream invariants", (protocol) => {
  it("omits empty history before serializing a request", async () => {
    const req = request(protocol);
    req.messages.unshift({ role: "assistant", text: "" }, { role: "assistant", text: "  " });
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = String(init.body);
      return new Response(textFrame(protocol) + terminal[protocol]);
    }));
    await collect(req);
    expect(body).not.toContain('"role":"assistant"');
  });
  it.each([false, true])("rejects empty streams (terminal=%s)", async (ended) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ended ? terminal[protocol] : "")));
    await expect(collect(request(protocol))).rejects.toMatchObject({ code: ended ? "provider_empty_response" : "provider_stream_incomplete" });
  });
  it("preserves partial output but rejects EOF without a terminal event", async () => {
    const events: ProviderEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(textFrame(protocol))));
    await expect(collect(request(protocol), events)).rejects.toMatchObject({ code: "provider_stream_incomplete" });
    expect(events).toContainEqual(expect.objectContaining({ type: "block", content: "partial" }));
    expect(events.some((event) => event.type === "complete")).toBe(false);
  });
  it("rejects missing tool results before contacting an upstream", async () => {
    const req = request(protocol);
    req.messages.push({ role: "assistant", text: "", toolCalls: [{ id: "call", name: "lookup", arguments: "{}" }] });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(collect(req)).rejects.toMatchObject({ code: "provider_message_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the final direct image count", () => {
    const req = request(protocol); req.capabilities.maxImageInputs = 1;
    req.messages = [{ role: "user", text: "images", images: [
      { mimeType: "image/png", dataBase64: "one" }, { mimeType: "image/png", dataBase64: "two" }
    ] }];
    expect(() => prepareMessages(req)).toThrow(expect.objectContaining({ code: "provider_image_limit" }));
  });
});

it("keeps native reasoning only for the same connection, protocol and model", () => {
  const req = request("openai-responses");
  const source = { role: "assistant" as const, text: "answer", providerConnectionId: req.connection.id,
    providerProtocol: req.connection.protocol, providerModelKey: req.modelKey,
    providerPayload: [{ type: "reasoning", encrypted_content: "opaque" }] };
  expect(projectMessages([source], req.connection, req.modelKey)[0]?.providerPayload).toBeDefined();
  expect(projectMessages([source], req.connection, "other")[0]?.providerPayload).toBeUndefined();
  expect(projectMessages([source], { ...req.connection, protocol: "anthropic-messages" }, req.modelKey)[0]?.providerPayload).toBeUndefined();
});
it("includes tool arguments, results, definitions and opaque content in estimates", () => {
  const large = "x".repeat(100_000);
  expect(estimateMessageTokens("", [{ role: "tool", text: "", toolResults: [{ callId: "call", name: "read", content: large }] }])).toBeGreaterThan(30_000);
  expect(estimateMessageTokens("", [{ role: "assistant", text: "", toolCalls: [{ id: "call", name: "write", arguments: JSON.stringify({ text: large }) }] }])).toBeGreaterThan(30_000);
  expect(estimateMessageTokens("", [], [{ name: "tool", description: large, inputSchema: {} }])).toBeGreaterThan(30_000);
  expect(estimateMessageTokens("", [{ role: "assistant", text: "", providerPayload: [{ encrypted_content: large }] }])).toBeGreaterThan(30_000);
});

it("accepts an explicit Responses output limit and preserves its reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(textFrame("openai-responses")
    + frame({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }))));
  expect((await collect(request("openai-responses"))).at(-1)).toEqual({ type: "complete", stopReason: "max_output_tokens" });
});
it("rejects incomplete Chat tool arguments even with a terminal marker", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{" } }] }, finish_reason: "tool_calls" }] }) + terminal["openai-chat"])));
  await expect(collect(request("openai-chat"))).rejects.toMatchObject({ code: "provider_tool_call_invalid" });
});
