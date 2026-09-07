import { createHash } from "node:crypto";

export interface RoleplayMacroContext {
  character: string;
  user: string;
  variables: Record<string, string | number | boolean>;
  seed: string;
  now?: number;
}

/** Render the portable, deterministic subset of Tavern-style macros. */
export function renderRoleplayMacros(value: string, context: RoleplayMacroContext): string {
  const now = new Date(context.now ?? Date.now());
  let randomIndex = 0;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (source, raw: string) => {
    const expression = raw.trim();
    const lower = expression.toLocaleLowerCase();
    if (lower === "char") return context.character;
    if (lower === "user") return context.user;
    if (lower === "date") return new Intl.DateTimeFormat("zh-CN").format(now);
    if (lower === "time") return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(now);
    if (lower === "weekday") return new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
    if (lower === "isodate") return now.toISOString();
    if (lower.startsWith("var::")) {
      const key = expression.slice(expression.indexOf("::") + 2).trim();
      return Object.hasOwn(context.variables, key) ? String(context.variables[key]) : source;
    }
    if (lower.startsWith("random:")) {
      const choices = expression.slice(expression.indexOf(":") + 1).split("::").map((item) => item.trim()).filter(Boolean);
      if (!choices.length) return source;
      return choices[seededInteger(context.seed, randomIndex++, choices.length)]!;
    }
    if (lower.startsWith("roll:")) {
      const sides = Number(expression.slice(expression.indexOf(":") + 1));
      if (!Number.isInteger(sides) || sides < 2 || sides > 1_000_000) return source;
      return String(seededInteger(context.seed, randomIndex++, sides) + 1);
    }
    return source;
  });
}

function seededInteger(seed: string, index: number, max: number): number {
  const bytes = createHash("sha256").update(`${seed}:${index}`).digest();
  return bytes.readUInt32BE(0) % max;
}
