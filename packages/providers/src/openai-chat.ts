import type { UsageDto } from "@llm-chat/contracts";
import { endpoint, ensureOk, headers, listModelEndpoint, readSse } from "./http";
import type { GenerateRequest, ProviderAdapter, ProviderEvent } from "./types";

export class OpenAiChatAdapter implements ProviderAdapter {
  readonly protocol = "openai-chat" as const;

  listModels = listModelEndpoint;

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderEvent> {
    const { common } = request.settings;
    const effort = request.settings.reasoningEffort;
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
    for (const message of request.messages) {
      if (message.role === "tool") {
        for (const result of message.toolResults ?? []) {
          messages.push({ role: "tool", tool_call_id: result.callId, content: result.content });
        }
        continue;
      }
      const converted: Record<string, unknown> = { role: message.role, content: message.text || null };
      if (message.role === "assistant" && message.toolCalls?.length) {
        converted.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }));
      }
      messages.push(converted);
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
    /**
     * Chat Completions has no explicit "disable reasoning" knob. We
     * simply omit the field for the unified `null` case; `max` is
     * clamped to "high" because the protocol has no higher tier.
     */
    if (request.capabilities.reasoning && effort !== "none") {
      body.reasoning_effort = effort;
    }

    const response = await fetch(endpoint(request.connection.baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(request.connection),
      body: JSON.stringify(body),
      signal: request.signal
    });
    await ensureOk(response);

    let text = "";
    let reasoning = "";
    let refusal = "";
    let stopReason = "stop";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const frame of readSse(response)) {
      if (frame.data === "[DONE]") break;
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
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoningDelta === "string") {
        reasoning += reasoningDelta;
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
      if (typeof choice?.finish_reason === "string") stopReason = choice.finish_reason;
      const rawUsage = event.usage as Record<string, unknown> | undefined;
      if (rawUsage) {
        const details = rawUsage.completion_tokens_details as Record<string, unknown> | undefined;
        const usage = compactUsage({
          inputTokens: number(rawUsage.prompt_tokens),
          outputTokens: number(rawUsage.completion_tokens),
          reasoningTokens: number(details?.reasoning_tokens),
          totalTokens: number(rawUsage.total_tokens)
        });
        yield { type: "usage", usage };
      }
    }
    if (reasoning) yield { type: "block", index: 0, blockType: "reasoning", content: reasoning, complete: true };
    if (text) yield { type: "block", index: 1, blockType: "text", content: text, complete: true };
    if (refusal) yield { type: "block", index: 2, blockType: "refusal", content: refusal, complete: true };
    for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      if (call.id && call.name) yield { type: "tool-call", call };
    }
    yield { type: "complete", stopReason };
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function compactUsage(value: Partial<Record<keyof UsageDto, number | undefined>>): UsageDto {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as UsageDto;
}
