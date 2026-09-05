import type { CharacterBookEntry, RoleplayPromptBlock } from "@llm-chat/contracts";
import type { ProviderMessage } from "@llm-chat/providers";
import type { AgentSnapshot, ContextMessageRecord } from "./database";
import { substituteCardPlaceholders } from "./database";
import { selectedRoleplayPreset } from "./roleplay";

export interface CompiledAgentPrompt {
  systemPrompt: string;
  exampleMessages: ProviderMessage[];
  postHistoryInstructions: string;
  beforeHistoryMessages: ProviderMessage[];
  afterHistoryMessages: ProviderMessage[];
  inChatMessages: Array<{ depth: number; message: ProviderMessage }>;
}

export function compileAgentPrompt(
  snapshot: AgentSnapshot,
  history: ContextMessageRecord[],
  availableInputTokens = 8_000
): CompiledAgentPrompt {
  if (snapshot.roleplay.enabled) return compileRoleplayPrompt(snapshot, history, availableInputTokens);
  return compileLegacyPrompt(snapshot, history, availableInputTokens);
}

function compileLegacyPrompt(
  snapshot: AgentSnapshot,
  history: ContextMessageRecord[],
  availableInputTokens: number
): CompiledAgentPrompt {
  const card = snapshot.card.data;
  const render = (value: string) => substituteCardPlaceholders(
    value,
    card.name,
    snapshot.userProfile.displayName
  );
  const rawSystem = render(card.system_prompt);
  const systemBase = rawSystem.trim()
    ? rawSystem.replace(/\{\{original\}\}/gi, snapshot.baseSystemPrompt)
    : snapshot.baseSystemPrompt;
  const lore = selectLoreEntries(card.character_book?.entries ?? [], history, {
    scanDepth: card.character_book?.scan_depth ?? 4,
    tokenBudget: card.character_book?.token_budget ?? Math.max(128, Math.floor(availableInputTokens * 0.25)),
    recursive: card.character_book?.recursive_scanning ?? false
  });
  const beforeLore = lore.filter((entry) => (entry.position ?? "before_char") === "before_char").map((entry) => render(entry.content));
  const afterLore = lore.filter((entry) => entry.position === "after_char").map((entry) => render(entry.content));
  const sections = [
    systemBase,
    section("世界信息", beforeLore.join("\n\n")),
    section("角色", [
      `名称：${render(card.name)}`,
      card.description ? `描述：${render(card.description)}` : "",
      card.personality ? `性格：${render(card.personality)}` : "",
      card.scenario ? `场景：${render(card.scenario)}` : ""
    ].filter(Boolean).join("\n")),
    section("补充世界信息", afterLore.join("\n\n")),
    section("用户", [
      `名称：${snapshot.userProfile.displayName}`,
      snapshot.userProfile.description ? `描述：${snapshot.userProfile.description}` : ""
    ].filter(Boolean).join("\n"))
  ].filter(Boolean);
  const examples = parseExampleMessages(render(card.mes_example), card.name, snapshot.userProfile.displayName);
  if (!examples.length && card.mes_example.trim()) sections.push(section("对话示例", render(card.mes_example)));
  return {
    systemPrompt: sections.join("\n\n"),
    exampleMessages: examples,
    postHistoryInstructions: render(card.post_history_instructions),
    beforeHistoryMessages: [],
    afterHistoryMessages: [],
    inChatMessages: []
  };
}

function compileRoleplayPrompt(
  snapshot: AgentSnapshot,
  history: ContextMessageRecord[],
  availableInputTokens: number
): CompiledAgentPrompt {
  const card = snapshot.card.data;
  const state = snapshot.roleplayState;
  const preset = selectedRoleplayPreset(snapshot.roleplay, state);
  if (!preset) return compileLegacyPrompt(snapshot, history, availableInputTokens);
  const persona = snapshot.roleplay.personas.find((item) => item.id === state.personaId);
  const userName = persona?.name || snapshot.userProfile.displayName;
  const render = (value: string) => substituteCardPlaceholders(value, card.name, userName);
  const rawSystem = render(card.system_prompt);
  const systemBase = rawSystem.trim()
    ? rawSystem.replace(/\{\{original\}\}/gi, snapshot.baseSystemPrompt)
    : snapshot.baseSystemPrompt;
  const entries = [
    ...(card.character_book?.entries ?? []),
    ...snapshot.roleplay.lorebooks
      .filter((book) => state.enabledLorebookIds.includes(book.id))
      .flatMap((book) => book.book.entries)
  ];
  const lore = selectLoreEntries(entries, history, {
    scanDepth: card.character_book?.scan_depth ?? 4,
    tokenBudget: card.character_book?.token_budget ?? Math.max(128, Math.floor(availableInputTokens * 0.25)),
    recursive: card.character_book?.recursive_scanning ?? false
  });
  const loreBefore = lore.filter((entry) => ["before_char", "before_examples"].includes(entry.position ?? "before_char"));
  const loreAfter = lore.filter((entry) => ["after_char", "after_examples"].includes(entry.position ?? "before_char"));
  const examples = parseExampleMessages(render(card.mes_example), card.name, userName);
  const historyOrder = preset.blocks.find((block) => block.kind === "history")?.order ?? Number.MAX_SAFE_INTEGER;
  const systemBefore: string[] = [];
  const systemAfter: string[] = [];
  const beforeHistoryMessages: ProviderMessage[] = [];
  const afterHistoryMessages: ProviderMessage[] = [];
  const inChatMessages: Array<{ depth: number; message: ProviderMessage }> = [];
  let exampleMessages: ProviderMessage[] = [];

  for (const block of [...preset.blocks].sort((a, b) => a.order - b.order)) {
    if (!block.enabled || !block.triggers.includes(snapshot.generationKind) || block.kind === "history") continue;
    const generated = roleplayBlockContent(block, {
      systemBase,
      character: section("角色", [
        `名称：${render(card.name)}`,
        card.description ? `描述：${render(card.description)}` : "",
        card.personality ? `性格：${render(card.personality)}` : "",
        (state.scenarioOverride || card.scenario) ? `场景：${render(state.scenarioOverride || card.scenario)}` : ""
      ].filter(Boolean).join("\n")),
      loreBefore: loreBefore.map((entry) => render(entry.content)).join("\n\n"),
      loreAfter: loreAfter.map((entry) => render(entry.content)).join("\n\n"),
      persona: section("用户", [
        `名称：${userName}`,
        (persona?.description || snapshot.userProfile.description)
          ? `描述：${render(persona?.description || snapshot.userProfile.description)}`
          : ""
      ].filter(Boolean).join("\n")),
      examples: render(card.mes_example),
      authorNote: render(state.authorNote),
      postHistory: render(card.post_history_instructions),
      render
    });
    if (!generated.trim()) continue;
    if (block.kind === "examples" && examples.length && !block.content.trim()) {
      exampleMessages = examples;
      continue;
    }
    if (block.position === "in_chat") {
      inChatMessages.push({ depth: block.depth, message: promptMessage(block.role, generated) });
      continue;
    }
    const beforeHistory = block.order < historyOrder;
    if (block.role === "system") {
      (beforeHistory ? systemBefore : systemAfter).push(generated);
    } else {
      (beforeHistory ? beforeHistoryMessages : afterHistoryMessages).push(promptMessage(block.role, generated));
    }
  }

  return {
    systemPrompt: systemBefore.join("\n\n"),
    exampleMessages,
    postHistoryInstructions: systemAfter.join("\n\n"),
    beforeHistoryMessages,
    afterHistoryMessages,
    inChatMessages
  };
}

function roleplayBlockContent(
  block: RoleplayPromptBlock,
  values: {
    systemBase: string;
    character: string;
    loreBefore: string;
    loreAfter: string;
    persona: string;
    examples: string;
    authorNote: string;
    postHistory: string;
    render: (value: string) => string;
  }
): string {
  const custom = values.render(block.content);
  if (custom.trim()) return custom.replace(/\{\{original\}\}/gi, values.systemBase);
  if (block.kind === "main") return values.systemBase;
  if (block.kind === "character") return values.character;
  if (block.kind === "lore_before") return section("世界信息", values.loreBefore);
  if (block.kind === "lore_after") return section("补充世界信息", values.loreAfter);
  if (block.kind === "persona") return values.persona;
  if (block.kind === "examples") return values.examples;
  if (block.kind === "author_note") return section("作者注释", values.authorNote);
  if (block.kind === "post_history") return values.postHistory;
  return "";
}

function promptMessage(role: RoleplayPromptBlock["role"], text: string): ProviderMessage {
  return { role: role === "system" ? "user" : role, text };
}

function section(title: string, content: string): string {
  return content.trim() ? `[${title}]\n${content.trim()}` : "";
}

function parseExampleMessages(text: string, characterName: string, userName: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const aliases = [characterName, "{{char}}", "<BOT>"].map(escapeRegExp).join("|");
  const userAliases = [userName, "{{user}}", "<USER>"].map(escapeRegExp).join("|");
  const line = new RegExp(`^\\s*(${aliases}|${userAliases})\\s*:\\s*(.*)$`, "i");
  let current: ProviderMessage | undefined;
  for (const raw of text.replace(/<START>/gi, "\n").split(/\r?\n/)) {
    const match = raw.match(line);
    if (match) {
      if (current) messages.push(current);
      const role = new RegExp(`^(?:${aliases})$`, "i").test(match[1]!) ? "assistant" : "user";
      current = { role, text: match[2] ?? "" };
    } else if (current && raw.trim()) {
      current.text += `\n${raw}`;
    }
  }
  if (current) messages.push(current);
  return messages.some((message) => message.role === "user") ? messages : [];
}

function selectLoreEntries(
  entries: CharacterBookEntry[],
  history: ContextMessageRecord[],
  options: { scanDepth: number; tokenBudget: number; recursive: boolean }
): CharacterBookEntry[] {
  const source = history.slice(-options.scanDepth).map((message) => message.text).join("\n");
  const ordered = entries
    .filter((entry) => entry.enabled !== false)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.insertion_order - b.insertion_order);
  const selected: CharacterBookEntry[] = [];
  const selectedSet = new Set<CharacterBookEntry>();
  let scanText = source;
  let used = 0;
  for (let pass = 0; pass < (options.recursive ? 8 : 1); pass += 1) {
    let changed = false;
    for (const entry of ordered) {
      if (selectedSet.has(entry)) continue;
      if (!entry.constant && !matchesLore(entry, scanText)) continue;
      const cost = estimate(entry.content);
      if (used + cost > options.tokenBudget) continue;
      selected.push(entry);
      selectedSet.add(entry);
      used += cost;
      scanText += `\n${entry.content}`;
      changed = true;
    }
    if (!changed) break;
  }
  return selected;
}

function matchesLore(entry: CharacterBookEntry, source: string): boolean {
  const normalize = (value: string) => entry.case_sensitive ? value : value.toLocaleLowerCase();
  const haystack = normalize(source);
  const primary = entry.keys.some((key) => key && haystack.includes(normalize(key)));
  if (!primary) return false;
  if (!entry.selective) return true;
  return (entry.secondary_keys ?? []).some((key) => key && haystack.includes(normalize(key)));
}

function estimate(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
