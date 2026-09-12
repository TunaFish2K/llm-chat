import { providerReasoningEffort } from "@llm-chat/contracts";
import { withMessage } from "@llm-chat/i18n";
import { prepareMessages, assertStreamComplete, validateToolCall } from "./messages";
import type { UsageDto } from "@llm-chat/contracts";
import { endpoint, ensureOk, headers, listModelEndpoint, readSse } from "./http";
import { ProviderError, type GenerateRequest, type ProviderAdapter, type ProviderEvent } from "./types";

interface AnthropicBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  partialJson?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  [key: string]: unknown;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly protocol = "anthropic-messages" as const;

  listModels = listModelEndpoint;

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderEvent> {
    const { common } = request.settings;
    const effort = providerReasoningEffort(request.settings);
    const capabilities = request.capabilities;
    const messages = prepareMessages(request).map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: (message.toolResults ?? []).map((result) => ({
            type: "tool_result",
            tool_use_id: result.callId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {})
          }))
        };
      }
      if (message.role === "assistant") {
        const content: unknown[] = message.providerConnectionId === request.connection.id && Array.isArray(message.providerPayload)
          ? [...message.providerPayload]
          : [];
        if (message.text) content.push({ type: "text", text: message.text });
        const existingIds = new Set(content.flatMap((block) => {
          const value = block as Record<string, unknown>;
          return value.type === "tool_use" && typeof value.id === "string" ? [value.id] : [];
        }));
        for (const call of message.toolCalls ?? []) {
          if (!existingIds.has(call.id)) {
            content.push({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments) });
          }
        }
        return { role: "assistant", content };
      }
      if (message.images?.length) {
        return {
          role: "user",
          content: [
            ...message.images.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 }
            })),
            ...(message.text ? [{ type: "text", text: message.text }] : [])
          ]
        };
      }
      return { role: "user", content: message.text };
    });
    const body: Record<string, unknown> = {
      model: request.modelKey,
      system: [request.systemPrompt, request.postHistoryInstructions].filter(Boolean).join("\n\n") || undefined,
      messages,
      max_tokens: common.maxOutputTokens,
      stream: true
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));
    }
    if (common.temperature !== undefined) body.temperature = common.temperature;
    if (common.topP !== undefined) body.top_p = common.topP;
    if (common.stopSequences.length) body.stop_sequences = common.stopSequences;

    /**
     * Anthropic mapping:
     *  - adaptiveThinking=true -> thinking=adaptive + output_config.effort
     *  - manualThinking=true and adaptiveThinking=false ->
     *      thinking=enabled with a deterministic budget derived from
     *      the unified tier (we DO NOT send output_config here, since
     *      the model has not advertised support for it).
     *  - unified null -> send neither `thinking` nor `output_config`.
     */
    if (capabilities.reasoning && effort !== null) {
      if (request.settings.reasoningSelection?.mode === "effort") {
        body.output_config = { effort };
        if (capabilities.adaptiveThinking) body.thinking = { type: "adaptive" };
      } else if (capabilities.adaptiveThinking) {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort };
      } else if (capabilities.manualThinking) {
        const budget = request.settings.resolvedThinkingBudgetTokens;
        if (!budget) throw withMessage(new ProviderError("reasoning_budget_missing", "手动 Thinking 缺少已解析的 token 预算"), "error.manual_thinking_requires_a_resolved_token_budget");
        body.thinking = {
          type: "enabled",
          budget_tokens: budget
        };
      }
    }

    const response = await fetch(endpoint(request.connection.baseUrl, "messages"), {
      method: "POST",
      headers: headers(request.connection, request.requestContext),
      body: JSON.stringify(body),
      signal: request.signal
    });
    await ensureOk(response);

    const blocks = new Map<number, AnthropicBlock>();
    let usageSnapshot: Record<string, unknown> = {};
    let ended = false;
    let hasOutput = false;
    let stopReason = "end_turn";
    for await (const frame of readSse(response)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof event.type === "string" ? event.type : frame.event;
      if (type === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        usageSnapshot = record(message?.usage);
      } else if (type === "content_block_start") {
        const index = number(event.index) ?? 0;
        const block = (event.content_block as AnthropicBlock | undefined) ?? { type: "unsupported" };
        blocks.set(index, { ...block });
        const normalized = blockEvent(index, block, false);
        if (normalized) yield normalized;
      } else if (type === "content_block_delta") {
        const index = number(event.index) ?? 0;
        const delta = (event.delta as Record<string, unknown> | undefined) ?? {};
        const block = blocks.get(index) ?? { type: "unsupported" };
        if (delta.type === "text_delta" && typeof delta.text === "string") block.text = (block.text ?? "") + delta.text;
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.thinking = (block.thinking ?? "") + delta.thinking;
        if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = (block.signature ?? "") + delta.signature;
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.partialJson = (block.partialJson ?? "") + delta.partial_json;
        blocks.set(index, block);
        const normalized = blockEvent(index, block, false);
        if (normalized) yield normalized;
      } else if (type === "content_block_stop") {
        const index = number(event.index) ?? 0;
        const block = blocks.get(index);
        if (block?.type === "tool_use" && block.id && block.name) {
          const call = { id: block.id, name: block.name, arguments: block.partialJson ?? JSON.stringify(block.input ?? {}) };
          validateToolCall(call);
          block.input = JSON.parse(call.arguments);
          delete block.partialJson;
          hasOutput = true;
          yield { type: "tool-call", call };
        } else if (block) {
          const normalized = blockEvent(index, block, true);
          if (normalized) yield normalized;
        }
      } else if (type === "message_stop") {
        ended = true;
      } else if (type === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
        usageSnapshot = { ...usageSnapshot, ...record(event.usage) };
        yield { type: "usage", usage: normalizeUsage(usageSnapshot) };
      } else if (type === "error") {
        const error = event.error as Record<string, unknown> | undefined;
        throw new Error(typeof error?.message === "string" ? error.message : "Anthropic 生成失败");
      }
    }
    assertStreamComplete(ended, hasOutput || [...blocks.values()].some((block) => block.type === "text" && Boolean(block.text?.trim())));
    const providerPayload = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block);
    if (providerPayload.length) yield { type: "provider-context", payload: providerPayload };
    yield { type: "complete", stopReason };
  }
}

function blockEvent(index: number, block: AnthropicBlock, complete: boolean): ProviderEvent | undefined {
  if (block.type === "text") {
    return { type: "block", index, blockType: "text", content: block.text ?? "", complete, providerPayload: block };
  }
  if (block.type === "thinking") {
    return { type: "block", index, blockType: "reasoning", content: block.thinking ?? "", complete, providerPayload: block };
  }
  if (block.type === "redacted_thinking") {
    return { type: "block", index, blockType: "reasoning", content: "[推理内容已由提供方隐藏]", complete, providerPayload: block };
  }
  if (block.type === "tool_use") return undefined;
  return {
    type: "block",
    index,
    blockType: "unsupported",
    content: `暂不支持的内容块：${block.type}`,
    complete,
    providerPayload: block
  };
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeUsage(value: unknown): UsageDto {
  if (!value || typeof value !== "object") return {};
  const usage = value as Record<string, unknown>;
  const uncachedInputTokens = number(usage.input_tokens);
  const cacheCreationInputTokens = number(usage.cache_creation_input_tokens);
  const cachedInputTokens = number(usage.cache_read_input_tokens);
  const hasInput = uncachedInputTokens !== undefined
    || cacheCreationInputTokens !== undefined
    || cachedInputTokens !== undefined;
  const inputTokens = hasInput
    ? (uncachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) + (cachedInputTokens ?? 0)
    : undefined;
  const outputTokens = number(usage.output_tokens);
  return compactUsage({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function compactUsage(value: Partial<Record<keyof UsageDto, number | undefined>>): UsageDto {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as UsageDto;
}
