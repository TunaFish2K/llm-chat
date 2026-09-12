import { withMessage } from "@llm-chat/i18n";
import { randomUUID } from "node:crypto";
import {
  agentRoleplayConfigSchema,
  conversationRoleplayStateSchema,
  roleplayPresetSchema,
  type AgentRoleplayConfig,
  type ConversationRoleplayState,
  type GenerationOverrides,
  type RoleplayPreset,
  type RoleplayPromptBlock
} from "@llm-chat/contracts";

const DEFAULT_BLOCKS: Array<Pick<RoleplayPromptBlock, "id" | "name" | "kind" | "role">> = [
  { id: "main", name: "主提示", kind: "main", role: "system" },
  { id: "lore-before", name: "世界信息（角色前）", kind: "lore_before", role: "system" },
  { id: "character", name: "角色定义", kind: "character", role: "system" },
  { id: "lore-after", name: "世界信息（角色后）", kind: "lore_after", role: "system" },
  { id: "persona", name: "用户身份", kind: "persona", role: "system" },
  { id: "examples", name: "对话示例", kind: "examples", role: "system" },
  { id: "history", name: "聊天记录", kind: "history", role: "system" },
  { id: "author-note", name: "作者注释", kind: "author_note", role: "system" },
  { id: "post-history", name: "历史后指令", kind: "post_history", role: "system" }
];

export function defaultRoleplayPreset(name = "默认角色扮演预设"): RoleplayPreset {
  return roleplayPresetSchema.parse({
    id: randomUUID(),
    name,
    blocks: DEFAULT_BLOCKS.map((block, order) => ({
      ...block,
      enabled: true,
      position: "relative",
      depth: 0,
      order,
      triggers: ["normal", "continue", "regenerate", "script"],
      content: ""
    })),
    generation: {},
    importedFrom: "native",
    importWarnings: []
  });
}

export function defaultRoleplayConfig(enabled = false): AgentRoleplayConfig {
  const preset = defaultRoleplayPreset();
  return agentRoleplayConfigSchema.parse({
    enabled,
    presets: [preset],
    defaultPresetId: preset.id,
    personas: [],
    defaultPersonaId: null,
    lorebooks: [],
    regexScripts: [],
    quickReplySets: [],
    assets: []
  });
}

export function parseRoleplayConfig(value: unknown, enabled = false): AgentRoleplayConfig {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = undefined;
    }
  }
  const parsed = agentRoleplayConfigSchema.safeParse(input);
  return parsed.success ? ensureRoleplayDefaults(parsed.data) : defaultRoleplayConfig(enabled);
}

export function ensureRoleplayDefaults(config: AgentRoleplayConfig): AgentRoleplayConfig {
  const presets = config.presets.length ? config.presets : [defaultRoleplayPreset()];
  const presetIds = new Set(presets.map((preset) => preset.id));
  const personaIds = new Set(config.personas.map((persona) => persona.id));
  return agentRoleplayConfigSchema.parse({
    ...config,
    presets,
    defaultPresetId: config.defaultPresetId && presetIds.has(config.defaultPresetId)
      ? config.defaultPresetId
      : presets[0]!.id,
    defaultPersonaId: config.defaultPersonaId && personaIds.has(config.defaultPersonaId)
      ? config.defaultPersonaId
      : config.personas[0]?.id ?? null
  });
}

export function resolveRoleplayState(
  config: AgentRoleplayConfig,
  value?: unknown
): ConversationRoleplayState {
  const candidate = conversationRoleplayStateSchema.safeParse(value);
  const state = candidate.success ? candidate.data : conversationRoleplayStateSchema.parse({});
  const explicit = candidate.success && value !== undefined && value !== null;
  const presetIds = new Set(config.presets.map((preset) => preset.id));
  const personaIds = new Set(config.personas.map((persona) => persona.id));
  const lorebookIds = new Set(config.lorebooks.map((book) => book.id));
  const regexIds = new Set(config.regexScripts.map((script) => script.id));
  const quickReplySetIds = new Set(config.quickReplySets.map((set) => set.id));
  const assetIds = new Set(config.assets.map((asset) => asset.id));
  return conversationRoleplayStateSchema.parse({
    ...state,
    presetId: state.presetId && presetIds.has(state.presetId) ? state.presetId : config.defaultPresetId,
    personaId: state.personaId && personaIds.has(state.personaId) ? state.personaId : config.defaultPersonaId,
    enabledLorebookIds: explicit
      ? state.enabledLorebookIds.filter((id) => lorebookIds.has(id))
      : config.lorebooks.filter((book) => book.enabled).map((book) => book.id),
    enabledRegexScriptIds: explicit
      ? state.enabledRegexScriptIds.filter((id) => regexIds.has(id))
      : config.regexScripts.filter((script) => script.enabled).map((script) => script.id),
    enabledQuickReplySetIds: explicit
      ? state.enabledQuickReplySetIds.filter((id) => quickReplySetIds.has(id))
      : config.quickReplySets.filter((set) => set.enabled).map((set) => set.id),
    backgroundAssetId: state.backgroundAssetId && assetIds.has(state.backgroundAssetId)
      ? state.backgroundAssetId
      : null,
    expressionAssetId: state.expressionAssetId && assetIds.has(state.expressionAssetId)
      ? state.expressionAssetId
      : null
  });
}

export function selectedRoleplayPreset(
  config: AgentRoleplayConfig,
  state: ConversationRoleplayState
): RoleplayPreset | undefined {
  if (!config.enabled) return undefined;
  return config.presets.find((preset) => preset.id === state.presetId)
    ?? config.presets.find((preset) => preset.id === config.defaultPresetId)
    ?? config.presets[0];
}

export function importSillyTavernPreset(raw: unknown, fileName = "preset.json"): RoleplayPreset {
  if (!isRecord(raw)) throw withMessage(new Error("预设文件必须是 JSON 对象"), "error.the_preset_file_must_be_a_json_object");
  const warnings: string[] = [];
  const promptRows = Array.isArray(raw.prompts) ? raw.prompts.filter(isRecord) : [];
  const orderRows = Array.isArray(raw.prompt_order) ? raw.prompt_order.filter(isRecord) : [];
  const activeOrder = orderRows.flatMap((row) => Array.isArray(row.order) ? row.order.filter(isRecord) : []);
  const orderById = new Map(activeOrder.map((row, index) => [String(row.identifier ?? ""), {
    order: index,
    enabled: row.enabled !== false
  }]));

  let blocks: RoleplayPromptBlock[] = promptRows.map((row, index) => {
    const identifier = String(row.identifier ?? row.id ?? `custom-${index + 1}`);
    const ordering = orderById.get(identifier);
    const kind = promptKind(identifier);
    const injectionPosition = Number(row.injection_position ?? 0);
    return {
      id: safeId(identifier, `block-${index + 1}`),
      name: String(row.name ?? identifier ?? `提示块 ${index + 1}`).slice(0, 200),
      kind,
      enabled: ordering?.enabled ?? row.enabled !== false,
      role: promptRole(row.role),
      position: injectionPosition === 1 || row.position === "in_chat" ? "in_chat" : "relative",
      depth: clampInteger(row.injection_depth ?? row.depth, 0, 10_000, 0),
      order: ordering?.order ?? index,
      triggers: ["normal", "continue", "regenerate", "script"],
      content: String(row.content ?? row.system_prompt ?? "").slice(0, 500_000)
    };
  });

  if (!blocks.some((block) => block.kind === "history")) {
    const fallback = defaultRoleplayPreset().blocks;
    blocks = blocks.length ? [...blocks, fallback.find((block) => block.kind === "history")!] : fallback;
  }
  blocks = uniqueBlockIds(blocks).sort((a, b) => a.order - b.order).map((block, order) => ({ ...block, order }));

  const generation = importGeneration(raw, warnings);
  const known = new Set([
    "name", "prompts", "prompt_order", "temperature", "temp", "top_p", "top_k", "min_p",
    "repetition_penalty", "rep_pen", "presence_penalty", "frequency_penalty", "max_tokens",
    "max_new_tokens", "stop", "stream_openai", "openai_max_context", "chat_completion_source"
  ]);
  const unsupported = Object.keys(raw).filter((key) => !known.has(key));
  if (unsupported.length) warnings.push(`保留但未应用 ${unsupported.length} 个供应商或界面专用字段`);
  if (!promptRows.length) warnings.push("文件没有 SillyTavern prompts，已采用 llm-chat 默认提示块顺序");

  return roleplayPresetSchema.parse({
    id: randomUUID(),
    name: String(raw.name ?? (fileName.replace(/\.json$/i, "") || "导入预设")).slice(0, 200),
    blocks,
    generation,
    importedFrom: "sillytavern",
    importWarnings: warnings,
    source: raw
  });
}

function importGeneration(raw: Record<string, unknown>, warnings: string[]): GenerationOverrides {
  const number = (keys: string[], min: number, max: number): number | undefined => {
    const key = keys.find((candidate) => typeof raw[candidate] === "number");
    if (!key) return undefined;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      warnings.push(`${key} 超出 llm-chat 支持范围，已忽略`);
      return undefined;
    }
    return value;
  };
  const maxOutputTokens = number(["max_tokens", "max_new_tokens"], 1, 10_000_000);
  const stop = Array.isArray(raw.stop)
    ? raw.stop.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (raw.top_k !== undefined || raw.min_p !== undefined || raw.repetition_penalty !== undefined || raw.rep_pen !== undefined) {
    warnings.push("top_k、min_p 和 repetition_penalty 不适用于当前提供方协议，已保留在原始数据中");
  }
  return {
    common: {
      temperature: number(["temperature", "temp"], 0, 2),
      topP: number(["top_p"], 0, 1),
      maxOutputTokens,
      stopSequences: stop
    }
  };
}

function promptKind(identifier: string): RoleplayPromptBlock["kind"] {
  const value = identifier.toLocaleLowerCase().replaceAll("_", "-");
  if (["main", "main-prompt", "system-prompt", "nsfw"].includes(value)) return "main";
  if (["world-info-before", "world-info-before-char", "lore-before"].includes(value)) return "lore_before";
  if (["char-description", "char-personality", "scenario", "character"].includes(value)) return "character";
  if (["world-info-after", "world-info-after-char", "lore-after"].includes(value)) return "lore_after";
  if (["persona-description", "persona"].includes(value)) return "persona";
  if (["dialogue-examples", "examples"].includes(value)) return "examples";
  if (["chat-history", "chathistory", "history"].includes(value)) return "history";
  if (["authors-note", "author-note"].includes(value)) return "author_note";
  if (["jailbreak", "post-history-instructions", "post-history"].includes(value)) return "post_history";
  return "custom";
}

function promptRole(value: unknown): RoleplayPromptBlock["role"] {
  return value === "user" || value === "assistant" ? value : "system";
}

function safeId(value: string, fallback: string): string {
  const id = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return id || fallback;
}

function uniqueBlockIds(blocks: RoleplayPromptBlock[]): RoleplayPromptBlock[] {
  const seen = new Set<string>();
  return blocks.map((block) => {
    let id = block.id;
    for (let suffix = 2; seen.has(id); suffix += 1) id = `${block.id.slice(0, 92)}-${suffix}`;
    seen.add(id);
    return { ...block, id };
  });
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
