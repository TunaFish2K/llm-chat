import { providerReasoningEffort } from "@llm-chat/contracts";
import { prepareMessages, assertStreamComplete, validateToolCall } from "./messages";
import type { UsageDto } from "@llm-chat/contracts";
import { endpoint, ensureOk, headers, listModelEndpoint, readSse } from "./http";
import type { GenerateRequest, ProviderAdapter, ProviderEvent } from "./types";

export class OpenAiChatAdapter implements ProviderAdapter {
  readonly protocol = "openai-chat" as const;

  listModels = listModelEndpoint;

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderEvent> {
    const { common } = request.settings;
    const effort = providerReasoningEffort(request.settings);
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
    const prepared = prepareMessages(request);
    // DeepSeek thinking mode rejects any assistant turn without reasoning_content once
    // the upstream has shown it uses that field; foreign or legacy turns get an empty one.
    const requiresReasoningContent = prepared.some((message) =>
      replayedReasoning(message.providerPayload)?.field === "reasoning_content");
    for (const message of prepared) {
      if (message.role === "tool") {
        for (const result of message.toolResults ?? []) {
          messages.push({ role: "tool", tool_call_id: result.callId, content: result.content });
        }
        continue;
      }
      const content = message.images?.length && message.role === "user"
        ? [
            ...message.images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}`, detail: "auto" }
            })),
            ...(message.text ? [{ type: "text", text: message.text }] : [])
          ]
        : message.text || null;
      // A reasoning-only step has nothing Chat Completions accepts as an assistant turn.
      if (message.role === "assistant" && !content && !message.toolCalls?.length) continue;
      const converted: Record<string, unknown> = { role: message.role, content };
      if (message.role === "assistant") {
        const replayed = replayedReasoning(message.providerPayload);
        if (replayed) converted[replayed.field] = replayed.content;
        else if (requiresReasoningContent) converted.reasoning_content = "";
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        converted.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }));
      }
      messages.push(converted);
    }
    if (request.postHistoryInstructions) {
      messages.push({ role: "developer", content: request.postHistoryInstructions });
    }
    const body: Record<string, unknown> = {
      model: request.modelKey,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: common.maxOutputTokens
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
      }));
    }
    if (common.temperature !== undefined) body.temperature = common.temperature;
    if (common.topP !== undefined) body.top_p = common.topP;
    if (common.stopSequences.length) body.stop = common.stopSequences;
    // null omits the parameter; native strings, including "none", are sent unchanged.
    if (request.capabilities.reasoning && effort !== null) {
      body.reasoning_effort = effort;
    }

    const response = await fetch(endpoint(request.connection.baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(request.connection, request.requestContext),
      body: JSON.stringify(body),
      signal: request.signal
    });
    await ensureOk(response);

    let text = "";
    let reasoning = "";
    let usesReasoningContent = false;
    let refusal = "";
    let ended = false;
    let stopReason = "stop";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const frame of readSse(response)) {
      if (frame.data === "[DONE]") { ended = true; break; }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = event.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") {
        text += delta.content;
        yield { type: "block", index: 1, blockType: "text", content: text, complete: false };
      }
      // An empty reasoning_content key still marks an upstream that wants that field replayed.
      if (typeof delta?.reasoning_content === "string") usesReasoningContent = true;
      const reasoningText = reasoningDelta(delta);
      if (reasoningText) {
        reasoning += reasoningText;
        yield { type: "block", index: 0, blockType: "reasoning", content: reasoning, complete: false };
      }
      if (typeof delta?.refusal === "string") {
        refusal += delta.refusal;
        yield { type: "block", index: 2, blockType: "refusal", content: refusal, complete: false };
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof raw.index === "number" ? raw.index : toolCalls.size;
          const fn = raw.function as Record<string, unknown> | undefined;
          const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof raw.id === "string") current.id += raw.id;
          if (typeof fn?.name === "string") current.name += fn.name;
          if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
          toolCalls.set(index, current);
        }
      }
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) { stopReason = choice.finish_reason; ended = true; }
      const rawUsage = event.usage as Record<string, unknown> | undefined;
      if (rawUsage) {
        const completionDetails = rawUsage.completion_tokens_details as Record<string, unknown> | undefined;
        const promptDetails = rawUsage.prompt_tokens_details as Record<string, unknown> | undefined;
        const usage = compactUsage({
          inputTokens: number(rawUsage.prompt_tokens),
          outputTokens: number(rawUsage.completion_tokens),
          reasoningTokens: number(completionDetails?.reasoning_tokens),
          cachedInputTokens: firstNumber(
            promptDetails?.cached_tokens,
            rawUsage.cached_tokens,
            rawUsage.prompt_cache_hit_tokens
          ),
          totalTokens: number(rawUsage.total_tokens)
        });
        yield { type: "usage", usage };
      }
    }
    for (const call of toolCalls.values()) validateToolCall(call);
    assertStreamComplete(ended, Boolean(text.trim() || refusal.trim() || toolCalls.size));
    if (reasoning) yield { type: "block", index: 0, blockType: "reasoning", content: reasoning, complete: true };
    if (reasoning) {
      // Returned in the field this upstream uses when this history is replayed.
      const field: ReasoningField = usesReasoningContent ? "reasoning_content" : "reasoning";
      yield { type: "provider-context", payload: [{ type: "reasoning_content", field, content: reasoning }] };
    }
    if (text) yield { type: "block", index: 1, blockType: "text", content: text, complete: true };
    if (refusal) yield { type: "block", index: 2, blockType: "refusal", content: refusal, complete: true };
    for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      if (call.id && call.name) yield { type: "tool-call", call };
    }
    yield { type: "complete", stopReason };
  }
}

type ReasoningField = "reasoning_content" | "reasoning";

function replayedReasoning(payload: unknown): { field: ReasoningField; content: string } | undefined {
  if (!Array.isArray(payload)) return undefined;
  for (const item of payload as Array<Record<string, unknown>>) {
    if (item?.type === "reasoning_content" && typeof item.content === "string"
      && (item.field === "reasoning_content" || item.field === "reasoning")) {
      return { field: item.field, content: item.content };
    }
  }
  return undefined;
}

/** Relays may send an empty field next to the populated one, so take the first non-empty text. */
function reasoningDelta(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";
  for (const value of [delta.reasoning_content, delta.reasoning]) {
    if (typeof value === "string" && value) return value;
  }
  if (!Array.isArray(delta.reasoning_details)) return "";
  return (delta.reasoning_details as Array<Record<string, unknown>>)
    .map((detail) => typeof detail?.text === "string" ? detail.text : typeof detail?.summary === "string" ? detail.summary : "")
    .join("");
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = number(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function compactUsage(value: Partial<Record<keyof UsageDto, number | undefined>>): UsageDto {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as UsageDto;
}
