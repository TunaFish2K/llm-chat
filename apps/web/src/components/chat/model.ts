/**
 * Pure conversation-surface logic: no React, no DOM.
 *
 * Keeping the ordering rules and override arithmetic here means the visual
 * components stay declarative and the tricky parts can be reasoned about (and
 * unit tested) on their own.
 */
import type {
  AgentSummaryDto,
  AppSettings,
  ContextPolicy,
  ConversationExecutionOverrides,
  GenerationDto,
  ImageGenerationJobDto,
  MessageDto,
  ReasoningEffort,
  ToolCallDto
} from "@llm-chat/contracts";

type ContentBlock = GenerationDto["blocks"][number];

/** Sentinel used by the override selects to mean "delete this field". */
export const INHERIT = "__inherit__";
/** Sentinel used by the model selects to mean "explicitly no model". */
export const NO_MODEL = "__none__";

export const REASONING_LEVELS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
export const CONTEXT_POLICIES: ContextPolicy[] = ["auto", "trim", "summarize", "full"];

/** Stable identity so store selectors do not re-render on every read. */
export const EMPTY_MESSAGES: MessageDto[] = [];

export type ImageJobsByToolCall = ReadonlyMap<string, readonly ImageGenerationJobDto[]>;

/** Keep stored messages intact; only move owned image jobs on the chat surface. */
export function projectImageJobs(messages: MessageDto[]): {
  messages: MessageDto[];
  imageJobs: ImageJobsByToolCall;
} {
  const calls = new Set(messages.filter((message) => message.role === "assistant")
    .flatMap((message) => message.generations.flatMap((generation) => generation.toolCalls.map((call) => call.id))));
  const imageJobs = new Map<string, ImageGenerationJobDto[]>();
  const visible = messages.filter((message) => {
    const job = message.imageGenerationJob;
    if (message.role !== "assistant" || message.generations.length || message.text || !job?.toolCallId || !calls.has(job.toolCallId)) return true;
    const jobs = imageJobs.get(job.toolCallId) ?? [];
    jobs.push(job);
    imageJobs.set(job.toolCallId, jobs);
    return false;
  });
  return { messages: visible, imageJobs };
}

export interface GreetingOption {
  sourceIndex: number;
  text: string;
}

/** Mirrors the server-side Character Card substitutions used when a greeting is persisted. */
export function greetingOptions(agent: AgentSummaryDto, settings: AppSettings | null): GreetingOption[] {
  const userName = agent.userProfile.displayName ?? settings?.userProfile.displayName ?? "User";
  return [agent.firstMessage, ...agent.alternateGreetings]
    .map((text, sourceIndex) => ({
      sourceIndex,
      text: text
        .replace(/\{\{char\}\}|<BOT>/gi, agent.name)
        .replace(/\{\{user\}\}|<USER>/gi, userName)
    }))
    .filter((item) => item.text.trim().length > 0);
}

export type TimelineEntry =
  | { kind: "block"; stepIndex: number; index: number; block: ContentBlock }
  | { kind: "tool"; stepIndex: number; index: number; call: ToolCallDto };

/**
 * Interleave content blocks and tool calls the way the model produced them:
 * by step, then blocks before the tools they triggered, then by index.
 */
export function buildTimeline(generation: GenerationDto): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...generation.blocks.map((block) => ({ kind: "block" as const, stepIndex: block.stepIndex, index: block.index, block })),
    ...generation.toolCalls.map((call) => ({ kind: "tool" as const, stepIndex: call.stepIndex, index: call.index, call }))
  ];
  return entries.sort(
    (left, right) =>
      left.stepIndex - right.stepIndex ||
      (left.kind === right.kind ? left.index - right.index : left.kind === "block" ? -1 : 1)
  );
}

export type ProcessEntry = TimelineEntry;
export type DisplayTimelineEntry = Extract<TimelineEntry, { kind: "block" }>
  | { kind: "image-result"; call: ToolCallDto; jobs: readonly ImageGenerationJobDto[] }
  | { kind: "process"; id: string; entries: ProcessEntry[]; followedByAnswer: boolean };

function generatesImage(call: ToolCallDto): boolean {
  if (call.name !== "image_generate") return false;
  try { return JSON.parse(call.arguments)?.action !== "list_models"; }
  catch { return false; }
}

/** Group adjacent processing steps without moving prose across tool calls. */
export function groupTimeline(generation: GenerationDto, imageJobs?: ImageJobsByToolCall): DisplayTimelineEntry[] {
  const result: DisplayTimelineEntry[] = [];
  for (const entry of buildTimeline(generation)) {
    if (entry.kind === "tool" || entry.block.type === "reasoning") {
      const previous = result.at(-1);
      if (previous?.kind === "process") previous.entries.push(entry);
      else result.push({ kind: "process", id: entry.kind === "tool" ? entry.call.id : entry.block.id, entries: [entry], followedByAnswer: false });
      if (entry.kind === "tool" && (imageJobs?.has(entry.call.id) || generatesImage(entry.call))) {
        const jobs = imageJobs?.get(entry.call.id) ?? [];
        const process = result.at(-1)!;
        if (process.kind === "process" && jobs.length && jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status))) process.followedByAnswer = true;
        // Reserve the boundary before the job arrives so streaming cannot regroup later steps.
        result.push({ kind: "image-result", call: entry.call, jobs });
      }
    } else {
      const previous = result.at(-1)?.kind === "image-result" ? result.at(-2) : result.at(-1);
      if (previous?.kind === "process" && entry.block.type === "text" && entry.block.content.trim()) previous.followedByAnswer = true;
      result.push(entry);
    }
  }
  return result;
}

/** The generation a message currently displays — the pinned one, else the newest. */
export function activeGeneration(message: MessageDto): GenerationDto | null {
  return message.generations.find((item) => item.id === message.activeGenerationId) ?? message.generations.at(-1) ?? null;
}

/** Every answer block concatenated, for the copy action. */
export function answerText(generation: GenerationDto): string {
  return generation.blocks.filter((block) => block.type === "text").map((block) => block.content).join("");
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Last path segment, so a long workspace path still fits in a chip. */
export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || "/";
}

/**
 * Write one nested generation parameter, pruning empty containers so the saved
 * override object never carries `{ generation: { common: {} } }` noise.
 */
export function withGenerationValue(
  current: ConversationExecutionOverrides,
  group: "common" | "protocol",
  key: string,
  next: unknown
): ConversationExecutionOverrides {
  const output = structuredClone(current);
  const generation = { ...(output.generation ?? {}) };
  const values = { ...(generation[group] ?? {}) } as Record<string, unknown>;
  if (next === undefined) delete values[key];
  else values[key] = next;
  if (Object.keys(values).length) generation[group] = values as never;
  else delete generation[group];
  if (Object.keys(generation).length) output.generation = generation;
  else delete output.generation;
  return output;
}

/** Resolve each user turn without crossing the next user message. */
export function userReplyTargets(messages: MessageDto[]): Map<string, string> {
  const targets = new Map<string, string>();
  let userId: string | undefined;
  for (const message of messages) {
    if (message.role === "user") userId = message.id;
    else if (userId && message.generations.length > 0) {
      targets.set(userId, message.id);
      userId = undefined;
    }
  }
  return targets;
}
