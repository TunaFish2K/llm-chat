import { describe, expect, it } from "vitest";
import {
  defaultRoleplayConfig,
  ensureRoleplayDefaults,
  importSillyTavernPreset,
  parseRoleplayConfig,
  resolveRoleplayState,
  selectedRoleplayPreset
} from "./roleplay";

describe("roleplay configuration", () => {
  it("imports common SillyTavern prompt order and generation fields", () => {
    const preset = importSillyTavernPreset({
      name: "Story",
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      prompts: [
        { identifier: "main", name: "Main", role: "system", content: "{{original}}\nStory rules" },
        { identifier: "chatHistory", name: "History", role: "system", content: "" }
      ],
      prompt_order: [{ order: [
        { identifier: "main", enabled: true },
        { identifier: "chatHistory", enabled: true }
      ] }]
    }, "story.json");

    expect(preset).toMatchObject({
      name: "Story",
      importedFrom: "sillytavern",
      generation: { common: { temperature: 0.8, topP: 0.9 } }
    });
    expect(preset.blocks.map((block) => block.kind)).toEqual(["main", "history"]);
    expect(preset.importWarnings.join(" ")).toContain("top_k");
  });

  it("keeps explicit empty selections while deriving defaults for a new conversation", () => {
    const config = defaultRoleplayConfig(true);
    config.lorebooks = [{
      id: "lore", name: "Lore", enabled: true,
      book: { name: "Lore", entries: [], extensions: {} }
    }];
    expect(resolveRoleplayState(config).enabledLorebookIds).toEqual(["lore"]);
    expect(resolveRoleplayState(config, { enabledLorebookIds: [] }).enabledLorebookIds).toEqual([]);
  });

  it("normalizes missing defaults and safely recovers malformed stored JSON", () => {
    const empty = parseRoleplayConfig("{}", false);
    expect(empty.enabled).toBe(false);
    expect(empty.presets).toHaveLength(1);
    expect(empty.defaultPresetId).toBe(empty.presets[0]!.id);
    expect(parseRoleplayConfig("not json", true).enabled).toBe(true);
    expect(parseRoleplayConfig({ enabled: "yes" }, false).enabled).toBe(false);

    const config = defaultRoleplayConfig(true);
    config.defaultPresetId = "missing";
    config.defaultPersonaId = "missing";
    config.personas = [{ id: "one", name: "One", description: "", avatarAssetId: null }];
    const normalized = ensureRoleplayDefaults(config);
    expect(normalized.defaultPresetId).toBe(normalized.presets[0]!.id);
    expect(normalized.defaultPersonaId).toBe("one");
  });

  it("prunes foreign conversation state and resolves preset fallbacks", () => {
    const config = defaultRoleplayConfig(true);
    config.personas = [{ id: "persona", name: "Persona", description: "", avatarAssetId: null }];
    config.defaultPersonaId = "persona";
    config.lorebooks = [{ id: "lore", name: "Lore", enabled: true, book: { entries: [], extensions: {} } }];
    config.regexScripts = [{
      id: "regex", name: "Regex", enabled: false, pattern: "x", replacement: "", flags: "gu",
      scopes: ["display"], runOnEdit: false, importWarning: null
    }];
    config.quickReplySets = [{ id: "quick", name: "Quick", enabled: true, replies: [] }];
    config.assets = [{ id: "asset", type: "background", name: "Background", ext: "png", uri: "bg.png", mimeType: "image/png", hash: null }];
    const state = resolveRoleplayState(config, {
      presetId: "foreign", personaId: "foreign", enabledLorebookIds: ["lore", "foreign"],
      enabledRegexScriptIds: ["regex", "foreign"], enabledQuickReplySetIds: ["quick", "foreign"],
      backgroundAssetId: "asset", expressionAssetId: "asset"
    });
    expect(state).toMatchObject({
      presetId: config.defaultPresetId, personaId: "persona", enabledLorebookIds: ["lore"],
      enabledRegexScriptIds: ["regex"], enabledQuickReplySetIds: ["quick"],
      backgroundAssetId: "asset", expressionAssetId: "asset"
    });
    expect(selectedRoleplayPreset({ ...config, enabled: false }, state)).toBeUndefined();
    expect(selectedRoleplayPreset(config, { ...state, presetId: "foreign" })?.id).toBe(config.defaultPresetId);
    expect(selectedRoleplayPreset({ ...config, defaultPresetId: null }, { ...state, presetId: null })?.id)
      .toBe(config.presets[0]!.id);
    expect(resolveRoleplayState(config, "invalid").personaId).toBe("persona");
  });

  it("imports aliases, injected messages, stops, and unsupported fields without executing them", () => {
    const identifiers = [
      "world_info_before", "char_description", "world_info_after", "persona_description",
      "dialogue_examples", "authors_note", "jailbreak", "odd custom"
    ];
    const preset = importSillyTavernPreset({
      max_tokens: 2048,
      stop: ["END", 7, "DONE"],
      top_p: 5,
      presence_penalty: 0.5,
      unknown_vendor_option: true,
      prompts: identifiers.map((identifier, index) => ({
        identifier,
        name: identifier,
        role: index === 1 ? "assistant" : index === 2 ? "user" : "invalid",
        injection_position: index === 0 ? 1 : 0,
        injection_depth: "3.8",
        content: identifier
      }))
    }, "preset.json");
    expect(preset.blocks.map((block) => block.kind)).toEqual([
      "lore_before", "character", "lore_after", "persona", "examples", "author_note",
      "post_history", "history", "custom"
    ]);
    expect(preset.blocks[0]).toMatchObject({ position: "in_chat", depth: 3, role: "system" });
    expect(preset.blocks[1]!.role).toBe("assistant");
    expect(preset.blocks[2]!.role).toBe("user");
    expect(preset.generation.common).toMatchObject({ maxOutputTokens: 2048, stopSequences: ["END", "DONE"] });
    expect(preset.generation.common?.topP).toBeUndefined();
    expect(preset.importWarnings.join(" ")).toContain("top_p");
    expect(preset.importWarnings.join(" ")).toContain("供应商");
  });

  it("uses the native fallback for sparse files and rejects non-object input", () => {
    const preset = importSillyTavernPreset({ name: "Sparse" });
    expect(preset.blocks.some((block) => block.kind === "history")).toBe(true);
    expect(preset.importWarnings.join(" ")).toContain("没有 SillyTavern prompts");
    expect(() => importSillyTavernPreset([])).toThrow("JSON 对象");
  });

  it("deduplicates imported block IDs and honors explicit order flags", () => {
    const preset = importSillyTavernPreset({
      prompts: [
        { identifier: "same id", name: "First", position: "in_chat", content: "one" },
        { identifier: "same id", name: "Second", content: "two" },
        { identifier: "", name: "Fallback", content: "three" }
      ],
      prompt_order: [{ order: [{ identifier: "same id", enabled: false }] }]
    });
    expect(new Set(preset.blocks.map((block) => block.id)).size).toBe(preset.blocks.length);
    expect(preset.blocks.find((block) => block.name === "First")).toMatchObject({
      enabled: false,
      position: "in_chat"
    });
  });
});
