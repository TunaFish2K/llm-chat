import { localizedToolFormatters } from "@llm-chat/i18n/tool-presentation";
import type { ToolMarkdown, ToolPresentation, ToolResultFormatInput } from "@llm-chat/contracts";

/** Callbacks must be pure, fast projections of the supplied data. */
export interface ToolFormatters {
  formatArguments?: (input: Record<string, unknown>) => ToolMarkdown | Promise<ToolMarkdown>;
  formatResult?: (result: ToolResultFormatInput) => ToolMarkdown | Promise<ToolMarkdown>;
}

function clip(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = "…（已截断）";
  return Buffer.from(value).subarray(0, bytes - Buffer.byteLength(suffix)).toString("utf8").replace(/\uFFFD$/, "") + suffix;
}

export function normalizeToolMarkdown(value: unknown): ToolMarkdown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.summary !== undefined && typeof candidate.summary !== "string") || (candidate.detail !== undefined && typeof candidate.detail !== "string")) return undefined;
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const detail = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
  return summary || detail ? {
    ...(summary ? { summary: Array.from(summary).length > 512 ? Array.from(summary).slice(0, 503).join("") + "…（已截断）" : summary } : {}),
    ...(detail ? { detail: clip(detail, 64 * 1024) } : {})
  } : undefined;
}

/** Formatting never retries execution or changes its outcome. */
export async function formatTool<T>(formatter: ((input: T) => unknown) | undefined, input: T): Promise<ToolMarkdown | undefined> {
  if (!formatter) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return normalizeToolMarkdown(await Promise.race([
      Promise.resolve().then(() => formatter(input)),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); })
    ]));
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

export function builtinToolFormatters(name: string): ToolFormatters | undefined {
  return localizedToolFormatters(name, "zh-CN");
}
function parse(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

/** Legacy builtins are pure projections; viewing history never loads a plugin. */
export function legacyToolPresentation(name: string, argumentsJson: string, output: string | null, error: string | null): ToolPresentation | undefined {
  const formatter = builtinToolFormatters(name);
  const input = parse(argumentsJson);
  if (!formatter || !object(input)) return undefined;
  try {
    return {
      arguments: normalizeToolMarkdown(formatter.formatArguments!(input)),
      ...(output !== null ? { result: normalizeToolMarkdown(formatter.formatResult!({ input, output, error })) } : {})
    } as ToolPresentation;
  } catch { return undefined; }
}
