import type { AgentRegexScript } from "@llm-chat/contracts";
import { RE2 } from "re2-wasm";

export type RegexScope = AgentRegexScript["scopes"][number];

export function validateSafeRegex(pattern: string, flags: string): string | null {
  try {
    compile(pattern, flags);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "正则表达式无效";
  }
}

export function applySafeRegex(
  value: string,
  scripts: AgentRegexScript[],
  enabledIds: string[],
  scope: RegexScope
): string {
  let output = value;
  for (const script of scripts) {
    if (!script.enabled || !enabledIds.includes(script.id) || !script.scopes.includes(scope)) continue;
    output = output.replace(compile(script.pattern, script.flags), script.replacement);
    if (output.length > 2_000_000) output = output.slice(0, 2_000_000);
  }
  return output;
}

function compile(pattern: string, flags: string): RE2 {
  if (pattern.length > 20_000) throw new Error("正则表达式过长");
  const normalized = [...new Set(flags.replace(/[^gimsuy]/g, "").split(""))].join("");
  return new RE2(pattern, normalized.includes("u") ? normalized : `${normalized}u`);
}
