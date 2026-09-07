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
