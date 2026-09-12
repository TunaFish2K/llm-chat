import { withMessage } from "@llm-chat/i18n";
import { ProviderError, type GenerateRequest, type ProviderConnection, type ProviderMessage, type ProviderToolCall, type ProviderToolDefinition } from "./types";

/** Project portable history into the content this connection can actually replay. */
export function projectMessages(messages: ProviderMessage[], connection: ProviderConnection, modelKey: string): ProviderMessage[] {
  return messages.flatMap((source): ProviderMessage[] => {
    const message = { ...source };
    const sameSource = message.providerConnectionId === connection.id
      && message.providerProtocol === connection.protocol && message.providerModelKey === modelKey;
    if (!sameSource || connection.protocol === "openai-chat" || !Array.isArray(message.providerPayload)) {
      delete message.providerPayload;
    } else {
      const payload = message.providerPayload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
      message.providerPayload = connection.protocol === "openai-responses"
        ? payload.filter((item) => item.type === "reasoning" || item.type === "image_generation_call")
        : payload.filter((item) => item.type === "redacted_thinking"
          || (item.type === "thinking" && typeof item.signature === "string" && Boolean(item.signature)));
      // Text and tool_use blocks come from the canonical history, including prompt regex changes.
      if (!(message.providerPayload as unknown[]).length) delete message.providerPayload;
    }
    if (message.role === "tool") return message.toolResults?.length ? [message] : [];
    if (!message.text.trim()) message.text = "";
    if (!message.text && !message.images?.length && !message.toolCalls?.length && !message.providerPayload) return [];
    return [message];
  });
}

export function validateToolCall(call: ProviderToolCall): void {
  let args: unknown;
  try { args = JSON.parse(call.arguments); } catch { /* Report one stable error below. */ }
  if (!call.id || !call.name || !args || typeof args !== "object" || Array.isArray(args)) {
    throw withMessage(new ProviderError("provider_tool_call_invalid", "上游工具调用缺少标识、名称或有效的 JSON 对象参数"), "error.the_upstream_tool_call_is_missing_an_id_name_or_valid_json");
  }
}

export function prepareMessages(request: GenerateRequest): ProviderMessage[] {
  const messages = projectMessages(request.messages, request.connection, request.modelKey);
  const pending = new Set<string>();
  let imageCount = 0;
  for (const message of messages) {
    imageCount += message.images?.length ?? 0;
    if (message.images?.length && message.role !== "user") {
      throw withMessage(new ProviderError("provider_message_invalid", "图片必须先转换为带来源说明的用户内容块"), "error.convert_images_to_user_content_blocks_with_source_information_first");
    }
    if (message.role === "tool") {
      for (const result of message.toolResults ?? []) {
        if (!pending.delete(result.callId)) throw withMessage(new ProviderError("provider_message_invalid", "工具结果没有对应的待完成调用"), "error.the_tool_result_has_no_corresponding_pending_call");
      }
      continue;
    }
    if (pending.size) throw withMessage(new ProviderError("provider_message_invalid", "工具调用与结果之间存在其他消息，或工具结果缺失"), "error.messages_appear_between_a_tool_call_and_its_results_or_results_are");
    for (const call of message.toolCalls ?? []) {
      validateToolCall(call);
      if (message.role !== "assistant" || pending.has(call.id)) throw withMessage(new ProviderError("provider_message_invalid", "工具调用角色或标识无效"), "error.invalid_tool_call_role_or_id");
      pending.add(call.id);
    }
  }
  if (pending.size) throw withMessage(new ProviderError("provider_message_invalid", "工具调用缺少结果"), "error.the_tool_call_has_no_result");
  if (imageCount && (!request.capabilities.imageInput || (request.capabilities.maxImageInputs != null && imageCount > request.capabilities.maxImageInputs))) {
    throw withMessage(new ProviderError("provider_image_limit", "请求图片数量超过模型能力，请先执行图片描述转换"), "error.the_image_count_exceeds_this_model_s_limit_convert_images_to_descriptions");
  }
  return messages;
}

/** Conservative estimate of transmitted content; image bytes are charged separately. */
export function estimateMessageTokens(systemPrompt: string, messages: ProviderMessage[], tools: ProviderToolDefinition[] = []): number {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(systemPrompt).byteLength;
  for (const message of messages) {
    bytes += encoder.encode(message.text).byteLength;
    for (const value of [message.toolCalls, message.toolResults, message.providerPayload]) {
      if (value) bytes += encoder.encode(JSON.stringify(value)).byteLength;
    }
  }
  if (tools.length) bytes += encoder.encode(JSON.stringify(tools)).byteLength;
  const images = messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0);
  return Math.ceil((bytes / 3 + images * 1600 + messages.length * 6 + 12) * 1.15);
}

export function assertStreamComplete(ended: boolean, hasOutput: boolean): void {
  if (!ended) throw withMessage(new ProviderError("provider_stream_incomplete", "上游响应流未正常结束，已保留收到的内容"), "error.the_upstream_stream_ended_unexpectedly_received_content_has_been_preserved");
  if (!hasOutput) throw withMessage(new ProviderError("provider_empty_response", "上游响应已结束，但没有返回正文、拒绝、图片或有效工具调用"), "error.the_upstream_response_ended_without_text_a_refusal_images_or_a_valid");
}
