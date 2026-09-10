import type { AgentRoleplayConfig, ConversationRoleplayState, ConversationRoleplayStatePatch } from "@llm-chat/contracts";
import { StoreError } from "./errors";

export interface StscriptResult {
  draft: string;
  sendText: string | null;
  output: string[];
  patch: ConversationRoleplayStatePatch;
  commands: number;
}

/** A deliberately small state-and-draft language. It has no eval, I/O, network, or loops. */
export function executeRestrictedStscript(
  source: string,
  draft: string,
  state: ConversationRoleplayState,
  config: AgentRoleplayConfig
): StscriptResult {
  if (source.length > 500_000) throw new StoreError("roleplay_script_too_large", "脚本内容过长");
  const commands = splitCommands(source);
  if (commands.length > 100) throw new StoreError("roleplay_script_too_many_commands", "单次最多执行 100 条脚本命令");
  const variables = { ...state.variables };
  const patch: ConversationRoleplayStatePatch = {};
  const output: string[] = [];
  let pipe = draft;
  let nextDraft = draft;
  let sendText: string | null = null;

  for (const command of commands) {
    const [name, ...args] = tokenize(command);
    const value = args.slice(1).join(" ") || pipe;
    if (name === "/setvar") {
      requireArg(args[0], name); variables[args[0]!] = scalar(value); pipe = String(variables[args[0]!] ?? "");
    } else if (name === "/getvar") {
      requireArg(args[0], name); pipe = Object.hasOwn(variables, args[0]!) ? String(variables[args[0]!] ?? "") : "";
    } else if (name === "/flushvar") {
      requireArg(args[0], name); delete variables[args[0]!]; pipe = "";
    } else if (name === "/flushvars") {
      for (const key of Object.keys(variables)) delete variables[key]; pipe = "";
    } else if (name === "/addvar" || name === "/incvar" || name === "/decvar") {
      requireArg(args[0], name);
      const delta = name === "/incvar" ? 1 : name === "/decvar" ? -1 : Number(args[1] ?? pipe);
      if (!Number.isFinite(delta)) throw new StoreError("roleplay_script_argument_invalid", `${name} 需要数字`);
      variables[args[0]!] = Number(variables[args[0]!] ?? 0) + delta;
      pipe = String(variables[args[0]!]!);
    } else if (name === "/echo") {
      pipe = args.join(" ") || pipe; output.push(pipe.slice(0, 20_000));
    } else if (name === "/input") {
      nextDraft = args.join(" ") || pipe; pipe = nextDraft;
    } else if (name === "/send") {
      sendText = args.join(" ") || pipe || nextDraft;
      if (!sendText.trim()) throw new StoreError("roleplay_script_argument_invalid", "/send 没有可发送内容");
      pipe = sendText;
    } else if (name === "/note") {
      patch.authorNote = args.join(" ") || pipe;
      pipe = patch.authorNote;
    } else if (name === "/scenario") {
      patch.scenarioOverride = args.join(" ") || pipe;
      pipe = patch.scenarioOverride;
    } else if (name === "/persona") {
      requireArg(args[0], name);
      if (!config.personas.some((item) => item.id === args[0])) throw new StoreError("roleplay_script_target_invalid", "人物身份不属于当前 Agent");
      patch.personaId = args[0]!;
    } else if (name === "/preset") {
      requireArg(args[0], name);
      if (!config.presets.some((item) => item.id === args[0])) throw new StoreError("roleplay_script_target_invalid", "预设不属于当前 Agent");
      patch.presetId = args[0]!;
    } else if (name === "/world") {
      requireArg(args[0], name);
      if (!config.lorebooks.some((item) => item.id === args[0])) throw new StoreError("roleplay_script_target_invalid", "世界书不属于当前 Agent");
      const enabled = !["off", "false", "0"].includes((args[1] ?? "on").toLocaleLowerCase());
      patch.enabledLorebookIds = enabled
        ? [...new Set([...(patch.enabledLorebookIds ?? state.enabledLorebookIds), args[0]!])]
        : (patch.enabledLorebookIds ?? state.enabledLorebookIds).filter((id) => id !== args[0]);
    } else {
      throw new StoreError("roleplay_script_command_unsupported", `不支持的命令：${name || command}`);
    }
  }
  patch.variables = variables;
  return { draft: nextDraft.slice(0, 1_000_000), sendText: sendText?.slice(0, 1_000_000) ?? null, output, patch, commands: commands.length };
}

function splitCommands(source: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote = "";
  for (const char of source.replace(/\r\n?/g, "\n")) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) quote = quote ? "" : char;
    if ((char === "|" || char === "\n") && !quote) {
      if (current.trim() && !current.trim().startsWith("#")) output.push(current.trim());
      current = "";
    } else current += char;
  }
  if (quote) throw new StoreError("roleplay_script_syntax_invalid", "脚本引号没有闭合");
  if (current.trim() && !current.trim().startsWith("#")) output.push(current.trim());
  return output;
}

function tokenize(source: string): string[] {
  return [...source.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function requireArg(value: string | undefined, command: string): void {
  if (!value) throw new StoreError("roleplay_script_argument_invalid", `${command} 缺少参数`);
}

function scalar(value: string): string | number | boolean {
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}
