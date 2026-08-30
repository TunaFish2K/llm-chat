import type { CharacterBookEntry } from "@llm-chat/contracts";
import type { ProviderMessage } from "@llm-chat/providers";
import type { AgentSnapshot, ContextMessageRecord } from "./database";
import { substituteCardPlaceholders } from "./database";

export interface CompiledAgentPrompt {
  systemPrompt: string;
  exampleMessages: ProviderMessage[];
  postHistoryInstructions: string;
}

export function compileAgentPrompt(
  snapshot: AgentSnapshot,
  history: ContextMessageRecord[],
  availableInputTokens = 8_000
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
    postHistoryInstructions: render(card.post_history_instructions)
  };
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
