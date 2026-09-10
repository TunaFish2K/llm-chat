import { prepareMessages, assertStreamComplete, validateToolCall } from "./messages";
import type { UsageDto } from "@llm-chat/contracts";
import { endpoint, ensureOk, headers, listModelEndpoint, readSse } from "./http";
import { ProviderError, type GenerateRequest, type ProviderAdapter, type ProviderEvent } from "./types";

/**
 * OpenAI Responses unified-effort mapping:
 *   none -> send no reasoning field
 *   every other value is sent unchanged, including non-standard max
 * `reasoningSummary` (model default) is only honoured when an effort
 * is engaged for this generation.
 */
export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly protocol = "openai-responses" as const;

  listModels = listModelEndpoint;

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderEvent> {
    const { common, protocol } = request.settings;
    const effort = request.settings.reasoningEffort;
    const input: unknown[] = [];
    for (const message of prepareMessages(request)) {
      if (message.role === "tool") {
        for (const result of message.toolResults ?? []) {
          input.push({ type: "function_call_output", call_id: result.callId, output: result.content });
        }
        continue;
      }
      if (
        message.role === "assistant" &&
        message.providerConnectionId === request.connection.id &&
        Array.isArray(message.providerPayload)
      ) {
        input.push(...message.providerPayload);
      }
      if (message.text || (message.role === "user" && message.images?.length)) {
        input.push({
          role: message.role,
          content: message.role === "assistant"
            ? [{ type: "output_text", text: message.text }]
            : message.images?.length
              ? [
                  ...message.images.map((image) => ({
                    type: "input_image",
                    image_url: `data:${image.mimeType};base64,${image.dataBase64}`,
                    detail: "auto"
                  })),
                  ...(message.text ? [{ type: "input_text", text: message.text }] : [])
                ]
              : message.text
        });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    if (request.postHistoryInstructions) {
      input.push({ role: "developer", content: request.postHistoryInstructions });
    }
    const body: Record<string, unknown> = {
      model: request.modelKey,
      input,
      instructions: request.systemPrompt || undefined,
      stream: true,
      store: false,
      max_output_tokens: common.maxOutputTokens
    };
    const tools: Array<Record<string, unknown>> = request.tools?.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false
      })) ?? [];
    if (request.capabilities.imageOutput) tools.push({ type: "image_generation" });
    if (tools.length) body.tools = tools;
    if (common.temperature !== undefined) body.temperature = common.temperature;
    if (common.topP !== undefined) body.top_p = common.topP;

    const reasoningAllowed = request.capabilities.reasoning;
    if (reasoningAllowed && effort !== "none") {
      const reasoning: Record<string, unknown> = {
        effort
      };
      if (request.capabilities.reasoningSummary && protocol.reasoningSummary) {
        reasoning.summary = protocol.reasoningSummary;
      }
      body.reasoning = reasoning;
      body.include = ["reasoning.encrypted_content"];
    }

    const response = await fetch(endpoint(request.connection.baseUrl, "responses"), {
      method: "POST",
      headers: headers(request.connection, request.requestContext),
      body: JSON.stringify(body),
      signal: request.signal
    });
    await ensureOk(response);

    let text = "";
    let reasoning = "";
    let refusal = "";
    let ended = false;
    let hasOutput = false;
    let stopReason = "stop";
    const providerItems: unknown[] = [];
    for await (const frame of readSse(response)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof event.type === "string" ? event.type : frame.event;
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (type === "response.output_text.delta") {
        text += delta;
        yield { type: "block", index: 1, blockType: "text", content: text, complete: false };
      } else if (type.includes("reasoning") && type.endsWith(".delta")) {
        reasoning += delta;
        yield { type: "block", index: 0, blockType: "reasoning", content: reasoning, complete: false };
      } else if (type === "response.refusal.delta") {
        refusal += delta;
        yield { type: "block", index: 2, blockType: "refusal", content: refusal, complete: false };
      } else if (type === "response.output_item.done" && event.item) {
        const item = event.item as Record<string, unknown>;
        if (item.type === "reasoning") providerItems.push(item);
        if (item.type === "image_generation_call") {
          if (typeof item.id === "string") providerItems.push({ type: item.type, id: item.id });
          if (typeof item.result !== "string" || !item.result) {
            throw new ProviderError("image_generation_result_missing", "Responses 未返回生成图片数据");
          }
          hasOutput = true;
          yield { type: "image", dataBase64: item.result };
        } else if (item.type === "function_call") {
          const id = typeof item.call_id === "string" ? item.call_id : String(item.id ?? "");
          const name = typeof item.name === "string" ? item.name : "";
          const args = typeof item.arguments === "string" ? item.arguments : "{}";
          const call = { id, name, arguments: args };
          validateToolCall(call);
          hasOutput = true;
          yield { type: "tool-call", call };
        } else if (item.type !== "reasoning" && item.type !== "message") {
          yield {
            type: "block",
            index: 100 + providerItems.length,
            blockType: "unsupported",
            content: `暂不支持的 Responses 内容项：${String(item.type ?? "unknown")}`,
            complete: true,
            providerPayload: item
          };
        }
      } else if (type === "response.completed" || type === "response.incomplete") {
        ended = true;
        const completed = event.response as Record<string, unknown> | undefined;
        const usage = normalizeUsage(completed?.usage);
        if (usage) yield { type: "usage", usage };
        const incomplete = completed?.incomplete_details as Record<string, unknown> | undefined;
        stopReason = typeof incomplete?.reason === "string" ? incomplete.reason : "stop";
      } else if (type === "response.failed") {
        const failed = event.response as Record<string, unknown> | undefined;
        const error = failed?.error as Record<string, unknown> | undefined;
        throw new Error(typeof error?.message === "string" ? error.message : "Responses 生成失败");
      }
    }
    assertStreamComplete(ended, hasOutput || Boolean(text.trim() || refusal.trim()));
    if (reasoning) yield { type: "block", index: 0, blockType: "reasoning", content: reasoning, complete: true };
    if (text) yield { type: "block", index: 1, blockType: "text", content: text, complete: true };
    if (refusal) yield { type: "block", index: 2, blockType: "refusal", content: refusal, complete: true };
    if (providerItems.length) yield { type: "provider-context", payload: providerItems };
    yield { type: "complete", stopReason };
  }
}

function normalizeUsage(value: unknown): UsageDto | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  return compactUsage({
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    reasoningTokens: number(outputDetails?.reasoning_tokens),
    cachedInputTokens: number(inputDetails?.cached_tokens),
    totalTokens: number(usage.total_tokens)
  });
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function compactUsage(value: Record<keyof UsageDto, number | undefined>): UsageDto {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as UsageDto;
}
