import { createHash } from "node:crypto";
import type { ContextPolicy, ContextSummaryDto, GenerationDto, GenerationSettings, ModelDto, UsageDto } from "@llm-chat/contracts";
import { adapterFor, type ProviderConnection, type ProviderMessage } from "@llm-chat/providers";
import { compileAgentPrompt } from "./agent-prompt";
import type { ContextMessageRecord, GenerationRecord, Store } from "./database";
import type { PreparedImages } from "./vision";

export interface BuiltContext {
  systemPrompt: string;
  messages: ProviderMessage[];
  postHistoryInstructions?: string;
  metadata: NonNullable<GenerationDto["context"]>;
}

export async function buildContext(
  store: Store,
  record: GenerationRecord,
  model: ModelDto,
  connection: ProviderConnection,
  signal: AbortSignal,
  preparedImages: PreparedImages = new Map()
): Promise<BuiltContext> {
  const rawMessages = store.contextMessages(record.conversationId, record.assistantMessageId);
  const policy = record.agentSnapshot.execution.contextPolicy;
  const preliminaryBudget = model.contextWindow
    ? Math.max(256, availableInputBudget(model, record.settings.common.maxOutputTokens))
    : 8_000;
  const compiled = compileAgentPrompt(record.agentSnapshot, rawMessages, preliminaryBudget);
  const countedPrompt = [compiled.systemPrompt, compiled.postHistoryInstructions].filter(Boolean).join("\n\n");
  let examples = compiled.exampleMessages;
  const realMessages = rawMessages.flatMap((message) => toProviderMessages(message, preparedImages));
  let providerMessages = [...examples, ...realMessages];
  let estimated = estimateTokens(countedPrompt, providerMessages);

  if (policy === "full") {
    return {
      systemPrompt: compiled.systemPrompt,
      messages: providerMessages,
      postHistoryInstructions: compiled.postHistoryInstructions,
      metadata: {
        policy: "full",
        strategy: "full",
        omittedMessages: 0,
        estimatedInputTokens: estimated,
        summaryUsed: false,
        summaryId: null,
        fallbackReason: null
      }
    };
  }
  if (!model.contextWindow) {
    throw new ContextError("context_window_required", "裁剪或摘要策略需要先配置模型上下文窗口");
  }
  const budget = availableInputBudget(model, record.settings.common.maxOutputTokens);
  if (budget < 256) throw new ContextError("context_budget_invalid", "最大输出已占满模型上下文窗口");
  if (estimated > budget && examples.length) {
    examples = [];
    providerMessages = realMessages;
    estimated = estimateTokens(countedPrompt, providerMessages);
  }
  const targetBudget = policy === "auto" ? Math.floor(budget * 0.8) : budget;
  if (estimated <= targetBudget) {
    return {
      systemPrompt: compiled.systemPrompt,
      messages: providerMessages,
      postHistoryInstructions: compiled.postHistoryInstructions,
      metadata: {
        policy,
        strategy: "raw",
        omittedMessages: 0,
        estimatedInputTokens: estimated,
        summaryUsed: false,
        summaryId: null,
        fallbackReason: null
      }
    };
  }
  if (policy === "trim") {
    return trimContext(policy, rawMessages, compiled.systemPrompt, compiled.postHistoryInstructions, budget, null, preparedImages);
  }
  if (policy === "auto") {
    try {
      return await summarizeContext(
        store, record, model, connection, rawMessages, compiled.systemPrompt,
        compiled.postHistoryInstructions, targetBudget, signal, preparedImages
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : "上下文摘要失败";
      return trimContext(policy, rawMessages, compiled.systemPrompt, compiled.postHistoryInstructions, budget, reason, preparedImages);
    }
  }
  return summarizeContext(store, record, model, connection, rawMessages, compiled.systemPrompt, compiled.postHistoryInstructions, budget, signal, preparedImages);
}

function trimContext(
  policy: ContextPolicy,
  rawMessages: ContextMessageRecord[],
  systemPrompt: string,
  postHistoryInstructions: string,
  budget: number,
  fallbackReason: string | null,
  preparedImages: PreparedImages
): BuiltContext {
  const countedPrompt = [systemPrompt, postHistoryInstructions].filter(Boolean).join("\n\n");
  let remaining = [...rawMessages];
  let omitted = 0;
  while (remaining.length > 1 && estimateTokens(countedPrompt, remaining.flatMap((message) => toProviderMessages(message, preparedImages))) > budget) {
    const nextUser = remaining.findIndex((message, index) => index > 0 && message.role === "user");
    const removeCount = nextUser > 0 ? nextUser : 1;
    remaining = remaining.slice(removeCount);
    omitted += removeCount;
  }
  const messages = remaining.flatMap((message) => toProviderMessages(message, preparedImages));
  const finalEstimate = estimateTokens(countedPrompt, messages);
  if (finalEstimate > budget) throw new ContextError("message_too_large", "最新消息超过模型可用上下文容量");
  return {
    systemPrompt,
    messages,
    postHistoryInstructions,
    metadata: {
      policy,
      strategy: omitted ? "trim" : "raw",
      omittedMessages: omitted,
      estimatedInputTokens: finalEstimate,
      summaryUsed: false,
      summaryId: null,
      fallbackReason
    }
  };
}

async function summarizeContext(
  store: Store,
  record: GenerationRecord,
  model: ModelDto,
  connection: ProviderConnection,
  allMessages: ContextMessageRecord[],
  originalSystemPrompt: string,
  postHistoryInstructions: string,
  budget: number,
  signal: AbortSignal,
  preparedImages: PreparedImages
): Promise<BuiltContext> {
  let summary = store.getLatestSummary(record.conversationId);
  if (summary) {
    const covered = allMessages.filter((message) => message.ordinal <= summary!.throughOrdinal);
    if (fingerprint(covered) !== summary.sourceFingerprint) summary = undefined;
  }
  let throughOrdinal = summary?.throughOrdinal ?? 0;
  let summaryText = summary?.text ?? "";
  let summaryId = summary?.id ?? null;
  let remaining = allMessages.filter((message) => message.ordinal > throughOrdinal);

  const composedSystem = () => summaryText
    ? `${originalSystemPrompt}\n\n[较早对话摘要]\n${summaryText}`.trim()
    : originalSystemPrompt;
  const countedSystem = () => [composedSystem(), postHistoryInstructions].filter(Boolean).join("\n\n");

  while (estimateTokens(countedSystem(), remaining.flatMap((message) => toProviderMessages(message, preparedImages))) > budget) {
    if (remaining.length <= 2) throw new ContextError("message_too_large", "最近一轮对话超过模型可用上下文容量");
    const chunk: ContextMessageRecord[] = [];
    const chunkBudget = Math.max(256, Math.floor(budget * 0.45));
    while (remaining.length > 2) {
      const candidate = remaining[0]!;
      const next = [...chunk, candidate];
      if (chunk.length && estimateTranscript(next, preparedImages) > chunkBudget) break;
      chunk.push(candidate);
      remaining = remaining.slice(1);
    }
    if (!chunk.length) throw new ContextError("summary_chunk_error", "无法为超长上下文选择摘要范围");
    const result = await generateSummary(connection, model, record.settings, summaryText, chunk, signal, preparedImages);
    summaryText = result.text;
    throughOrdinal = chunk.at(-1)!.ordinal;
    const covered = allMessages.filter((message) => message.ordinal <= throughOrdinal);
    summaryId = store.saveSummary({
      conversationId: record.conversationId,
      throughOrdinal,
      fingerprint: fingerprint(covered),
      text: summaryText,
      connectionId: connection.id,
      modelKey: model.modelKey,
      usage: result.usage
    });
  }

  const messages = remaining.flatMap((message) => toProviderMessages(message, preparedImages));
  return {
    systemPrompt: composedSystem(),
    messages,
    postHistoryInstructions,
    metadata: {
      policy: record.agentSnapshot.execution.contextPolicy,
      strategy: "summary",
      omittedMessages: allMessages.length - remaining.length,
      estimatedInputTokens: estimateTokens(countedSystem(), messages),
      summaryUsed: Boolean(summaryText),
      summaryId,
      fallbackReason: null
    }
  };
}

export async function compactConversationContext(
  store: Store,
  conversationId: string,
  signal: AbortSignal
): Promise<ContextSummaryDto> {
  const conversation = store.getConversation(conversationId);
  if (!conversation) throw new ContextError("conversation_not_found", "会话不存在");
  const resolved = store.resolveGeneration(conversation);
  const policy = resolved.snapshot.execution.contextPolicy;
  if (policy !== "auto" && policy !== "summarize") {
    throw new ContextError("context_compaction_disabled", "当前上下文策略不使用摘要压缩");
  }
  if (!resolved.model.contextWindow) {
    throw new ContextError("context_window_required", "压缩上下文需要先配置模型上下文窗口");
  }
  const availableBudget = availableInputBudget(
    resolved.model,
    resolved.snapshot.execution.settings.common.maxOutputTokens
  );
  if (availableBudget < 256) {
    throw new ContextError("context_budget_invalid", "最大输出已占满模型上下文窗口");
  }

  const allMessages = store.allContextMessages(conversationId);
  const userMessages = allMessages.filter((message) => message.role === "user");
  if (userMessages.length < 3) {
    throw new ContextError("context_compaction_not_needed", "至少需要三个完整对话轮次才能手动压缩");
  }
  const keepFromOrdinal = userMessages.at(-2)!.ordinal;
  const eligible = allMessages.filter((message) => message.ordinal < keepFromOrdinal);
  if (!eligible.some((message) => message.role === "user")) {
    throw new ContextError("context_compaction_not_needed", "没有可压缩的较早对话");
  }

  let previous = store.getLatestSummary(conversationId);
  if (previous) {
    const covered = allMessages.filter((message) => message.ordinal <= previous!.throughOrdinal);
    if (fingerprint(covered) !== previous.sourceFingerprint) previous = undefined;
  }
  if (previous && previous.throughOrdinal >= eligible.at(-1)!.ordinal) return store.getContextSummary(conversationId)!;

  const pending = eligible.filter((message) => message.ordinal > (previous?.throughOrdinal ?? 0));
  let summaryText = previous?.text ?? "";
  let usage: UsageDto = {};
  const chunkBudget = Math.max(256, Math.floor(availableBudget * 0.45));
  let remaining = pending;
  while (remaining.length) {
    if (signal.aborted) throw signal.reason;
    let end = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const next = remaining.slice(0, index + 1);
      if (index > 0 && estimateTranscript(next) > chunkBudget) break;
      if (remaining[index]!.role === "assistant") end = index + 1;
    }
    if (!end) end = remaining.findIndex((message) => message.role === "assistant") + 1 || remaining.length;
    const chunk = remaining.slice(0, end);
    const result = await generateSummary(
      resolved.connection,
      resolved.model,
      resolved.snapshot.execution.settings,
      summaryText,
      chunk,
      signal
    );
    summaryText = result.text;
    usage = addUsage(usage, result.usage);
    remaining = remaining.slice(end);
  }

  const throughOrdinal = eligible.at(-1)!.ordinal;
  const id = store.saveSummary({
    conversationId,
    throughOrdinal,
    fingerprint: fingerprint(eligible),
    text: summaryText,
    connectionId: resolved.connection.id,
    modelKey: resolved.model.modelKey,
    usage
  });
  return store.getContextSummary(conversationId) ?? {
    id,
    conversationId,
    throughOrdinal,
    text: summaryText,
    connectionId: resolved.connection.id,
    modelKey: resolved.model.modelKey,
    usage,
    createdAt: Date.now()
  };
}

function addUsage(left: UsageDto, right: UsageDto): UsageDto {
  const keys: Array<keyof UsageDto> = ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "totalTokens"];
  return Object.fromEntries(keys.flatMap((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return leftValue === undefined && rightValue === undefined ? [] : [[key, (leftValue ?? 0) + (rightValue ?? 0)]];
  })) as UsageDto;
}

async function generateSummary(
  connection: ProviderConnection,
  model: ModelDto,
  settings: GenerationSettings,
  previousSummary: string,
  messages: ContextMessageRecord[],
  signal: AbortSignal,
  preparedImages: PreparedImages = new Map()
): Promise<{ text: string; usage: UsageDto }> {
  const transcript = messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}${imageDescriptionText(message, preparedImages)}`)
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
  const summaryImages = messages.flatMap((message) => (message.images ?? []).flatMap((asset) => {
    const prepared = preparedImages.get(asset.id);
    return prepared?.image ? [prepared.image] : [];
  }));
  for await (const event of adapterFor(connection.protocol).stream({
    connection,
    modelKey: model.modelKey,
    systemPrompt: "你负责压缩对话上下文。只输出摘要正文。",
    messages: [{ role: "user", text: prompt, ...(summaryImages.length ? { images: summaryImages } : {}) }],
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

function availableInputBudget(model: ModelDto, reservedOutputTokens: number): number {
  const contextBudget = (model.contextWindow ?? 0) - reservedOutputTokens;
  return model.maxInputTokens ? Math.min(contextBudget, model.maxInputTokens) : contextBudget;
}

export function estimateTokens(systemPrompt: string, messages: ProviderMessage[]): number {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(systemPrompt).byteLength + messages.reduce(
    (total, message) => total + encoder.encode(message.text).byteLength,
    0
  );
  const imageTokens = messages.reduce((total, message) => total + (message.images?.length ?? 0) * 1_600, 0);
  return Math.ceil((textBytes / 3 + imageTokens + messages.length * 6 + 12) * 1.15);
}

function estimateTranscript(messages: ContextMessageRecord[], preparedImages: PreparedImages = new Map()): number {
  return estimateTokens("", messages.flatMap((message) => toProviderMessages(message, preparedImages)));
}

function toProviderMessages(message: ContextMessageRecord, preparedImages: PreparedImages): ProviderMessage[] {
  const providerImages = (message.images ?? []).flatMap((asset) => {
    const prepared = preparedImages.get(asset.id);
    return prepared?.image ? [prepared.image] : [];
  });
  const primary: ProviderMessage = {
    role: message.role,
    text: `${message.text}${imageDescriptionText(message, preparedImages)}`,
    ...(providerImages.length ? { images: providerImages } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.providerPayload !== undefined ? { providerPayload: message.providerPayload } : {}),
    ...(message.providerConnectionId ? { providerConnectionId: message.providerConnectionId } : {})
  };
  if (!message.toolResults?.length) return [primary];
  return [primary, { role: "tool", text: "", toolResults: message.toolResults }];
}

function imageDescriptionText(message: ContextMessageRecord, preparedImages: PreparedImages): string {
  const descriptions = (message.images ?? []).flatMap((asset) => {
    const prepared = preparedImages.get(asset.id);
    if (prepared?.description) {
      return [`<image_description file="${escapeAttribute(asset.fileName)}" trust="untrusted">\n${prepared.description}\n</image_description>`];
    }
    if (prepared?.image) return [];
    return [`<image_attachment file="${escapeAttribute(asset.fileName)}" description="unavailable" />`];
  });
  return descriptions.length ? `\n\n${descriptions.join("\n\n")}` : "";
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fingerprint(messages: ContextMessageRecord[]): string {
  return createHash("sha256")
    .update(messages.map((message) => `${message.messageId}:${message.text}:${JSON.stringify((message.images ?? []).map((image) => image.sha256))}:${JSON.stringify(message.toolCalls ?? [])}:${JSON.stringify(message.toolResults ?? [])}:${message.providerConnectionId ?? ""}`).join("\u0000"))
    .digest("hex");
}

export class ContextError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
