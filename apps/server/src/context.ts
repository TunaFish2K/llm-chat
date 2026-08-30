import { createHash } from "node:crypto";
import type { GenerationDto, GenerationSettings, ModelDto, UsageDto } from "@llm-chat/contracts";
import { adapterFor, type ProviderConnection, type ProviderMessage } from "@llm-chat/providers";
import type { ContextMessageRecord, GenerationRecord, Store } from "./database";

export interface BuiltContext {
  systemPrompt: string;
  messages: ProviderMessage[];
  metadata: NonNullable<GenerationDto["context"]>;
}

export async function buildContext(
  store: Store,
  record: GenerationRecord,
  model: ModelDto,
  connection: ProviderConnection,
  signal: AbortSignal
): Promise<BuiltContext> {
  const conversation = store.getConversation(record.conversationId);
  if (!conversation) throw new ContextError("conversation_not_found", "会话不存在");
  const rawMessages = store.contextMessages(record.conversationId, record.assistantMessageId);
  const providerMessages = rawMessages.flatMap(toProviderMessages);
  const estimated = estimateTokens(conversation.systemPrompt, providerMessages);

  if (conversation.contextPolicy === "full") {
    return {
      systemPrompt: conversation.systemPrompt,
      messages: providerMessages,
      metadata: {
        policy: "full",
        omittedMessages: 0,
        estimatedInputTokens: estimated,
        summaryUsed: false
      }
    };
  }
  if (!model.contextWindow) {
    throw new ContextError("context_window_required", "裁剪或摘要策略需要先配置模型上下文窗口");
  }
  const budget = model.contextWindow - record.settings.common.maxOutputTokens;
  if (budget < 256) throw new ContextError("context_budget_invalid", "最大输出已占满模型上下文窗口");
  if (estimated <= budget) {
    return {
      systemPrompt: conversation.systemPrompt,
      messages: providerMessages,
      metadata: {
        policy: conversation.contextPolicy,
        omittedMessages: 0,
        estimatedInputTokens: estimated,
        summaryUsed: false
      }
    };
  }
  if (conversation.contextPolicy === "trim") {
    const messages = [...providerMessages];
    let omitted = 0;
    while (messages.length > 1 && estimateTokens(conversation.systemPrompt, messages) > budget) {
      messages.shift();
      omitted += 1;
      if (messages[0]?.role === "assistant") {
        messages.shift();
        omitted += 1;
      }
    }
    const finalEstimate = estimateTokens(conversation.systemPrompt, messages);
    if (finalEstimate > budget) {
      throw new ContextError("message_too_large", "最新消息超过模型可用上下文容量");
    }
    return {
      systemPrompt: conversation.systemPrompt,
      messages,
      metadata: {
        policy: "trim",
        omittedMessages: omitted,
        estimatedInputTokens: finalEstimate,
        summaryUsed: false
      }
    };
  }
  return summarizeContext(store, record, model, connection, rawMessages, conversation.systemPrompt, budget, signal);
}

async function summarizeContext(
  store: Store,
  record: GenerationRecord,
  model: ModelDto,
  connection: ProviderConnection,
  allMessages: ContextMessageRecord[],
  originalSystemPrompt: string,
  budget: number,
  signal: AbortSignal
): Promise<BuiltContext> {
  let summary = store.getLatestSummary(record.conversationId);
  if (summary) {
    const covered = allMessages.filter((message) => message.ordinal <= summary!.throughOrdinal);
    if (fingerprint(covered) !== summary.sourceFingerprint) summary = undefined;
  }
  let throughOrdinal = summary?.throughOrdinal ?? 0;
  let summaryText = summary?.text ?? "";
  let remaining = allMessages.filter((message) => message.ordinal > throughOrdinal);

  const composedSystem = () => summaryText
    ? `${originalSystemPrompt}\n\n[较早对话摘要]\n${summaryText}`.trim()
    : originalSystemPrompt;

  while (estimateTokens(composedSystem(), remaining.flatMap(toProviderMessages)) > budget) {
    if (remaining.length <= 2) throw new ContextError("message_too_large", "最近一轮对话超过模型可用上下文容量");
    const chunk: ContextMessageRecord[] = [];
    const chunkBudget = Math.max(256, Math.floor(budget * 0.45));
    while (remaining.length > 2) {
      const candidate = remaining[0]!;
      const next = [...chunk, candidate];
      if (chunk.length && estimateTranscript(next) > chunkBudget) break;
      chunk.push(candidate);
      remaining = remaining.slice(1);
    }
    if (!chunk.length) throw new ContextError("summary_chunk_error", "无法为超长上下文选择摘要范围");
    const result = await generateSummary(connection, model, record.settings, summaryText, chunk, signal);
    summaryText = result.text;
    throughOrdinal = chunk.at(-1)!.ordinal;
    const covered = allMessages.filter((message) => message.ordinal <= throughOrdinal);
    store.saveSummary({
      conversationId: record.conversationId,
      throughOrdinal,
      fingerprint: fingerprint(covered),
      text: summaryText,
      connectionId: connection.id,
      modelKey: model.modelKey,
      usage: result.usage
    });
  }

  const messages = remaining.flatMap(toProviderMessages);
  return {
    systemPrompt: composedSystem(),
    messages,
    metadata: {
      policy: "summarize",
      omittedMessages: allMessages.length - remaining.length,
      estimatedInputTokens: estimateTokens(composedSystem(), messages),
      summaryUsed: Boolean(summaryText)
    }
  };
}

async function generateSummary(
  connection: ProviderConnection,
  model: ModelDto,
  settings: GenerationSettings,
  previousSummary: string,
  messages: ContextMessageRecord[],
  signal: AbortSignal
): Promise<{ text: string; usage: UsageDto }> {
  const transcript = messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`)
    .join("\n\n");
  const prompt = [
    previousSummary ? `现有摘要：\n${previousSummary}` : "",
    `需要合并的对话：\n${transcript}`,
    "请输出一份紧凑、客观的中文上下文摘要。保留用户要求、事实、约束、未完成事项和重要代码细节，不要增加推测。"
  ].filter(Boolean).join("\n\n");
  const summarySettings: GenerationSettings = {
    common: {
      maxOutputTokens: Math.min(1024, model.maxOutputTokens),
      stopSequences: [],
      ...(model.capabilities.temperature ? { temperature: 0 } : {})
    },
    protocol: {},
    // Summaries never engage reasoning: cheaper and provider-agnostic.
    reasoningEffort: "none"
  };
  let text = "";
  let usage: UsageDto = {};
  for await (const event of adapterFor(connection.protocol).stream({
    connection,
    modelKey: model.modelKey,
    systemPrompt: "你负责压缩对话上下文。只输出摘要正文。",
    messages: [{ role: "user", text: prompt }],
    settings: { ...settings, ...summarySettings },
    capabilities: model.capabilities,
    signal
  })) {
    if (event.type === "block" && event.blockType === "text") text = event.content;
    if (event.type === "usage") usage = { ...usage, ...event.usage };
  }
  if (!text.trim()) throw new ContextError("summary_empty", "上下文摘要模型没有返回文本");
  return { text: text.trim(), usage };
}

export function estimateTokens(systemPrompt: string, messages: ProviderMessage[]): number {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(systemPrompt).byteLength + messages.reduce(
    (total, message) => total + encoder.encode(message.text).byteLength,
    0
  );
  return Math.ceil((textBytes / 3 + messages.length * 6 + 12) * 1.15);
}

function estimateTranscript(messages: ContextMessageRecord[]): number {
  return estimateTokens("", messages.flatMap(toProviderMessages));
}

function toProviderMessages(message: ContextMessageRecord): ProviderMessage[] {
  const primary: ProviderMessage = {
    role: message.role,
    text: message.text,
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.providerPayload !== undefined ? { providerPayload: message.providerPayload } : {}),
    ...(message.providerConnectionId ? { providerConnectionId: message.providerConnectionId } : {})
  };
  if (!message.toolResults?.length) return [primary];
  return [primary, { role: "tool", text: "", toolResults: message.toolResults }];
}

function fingerprint(messages: ContextMessageRecord[]): string {
  return createHash("sha256")
    .update(messages.map((message) => `${message.messageId}:${message.text}:${JSON.stringify(message.toolCalls ?? [])}:${JSON.stringify(message.toolResults ?? [])}:${message.providerConnectionId ?? ""}`).join("\u0000"))
    .digest("hex");
}

export class ContextError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
