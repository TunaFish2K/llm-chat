import type { AgentSnapshot, ContextMessageRecord } from "./generation-types";
import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "./agent-prompt";
import { defaultRoleplayConfig } from "./roleplay";

describe("Agent prompt compiler", () => {
  it("compiles V2 prompts, placeholders, examples, post instructions, and positioned lore", () => {
    const snapshot = fixture();
    const history: ContextMessageRecord[] = [{
      messageId: "m1", ordinal: 1, role: "user", text: "The red key opens the archive."
    }];
    const result = compileAgentPrompt(snapshot, history, 2_000);
    expect(result.systemPrompt).toContain("Rules for Mira: BASE");
    expect(result.systemPrompt).toContain("Before lore for Lin");
    expect(result.systemPrompt).toContain("After lore for Mira");
    expect(result.systemPrompt.indexOf("Before lore")).toBeLessThan(result.systemPrompt.indexOf("[角色]"));
    expect(result.systemPrompt.indexOf("After lore")).toBeGreaterThan(result.systemPrompt.indexOf("[角色]"));
    expect(result.systemPrompt).not.toContain("creator only");
    expect(result.exampleMessages).toEqual([
      { role: "user", text: "Hello Mira" },
      { role: "assistant", text: "Hello Lin" }
    ]);
    expect(result.postHistoryInstructions).toBe("Stay in character as Mira.");
  });

  it("uses the base prompt when system_prompt is empty and safely keeps unparsed examples", () => {
    const snapshot = fixture();
    snapshot.card.data.system_prompt = "";
    snapshot.card.data.mes_example = "An example without role markers";
    const result = compileAgentPrompt(snapshot, []);
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("An example without role markers");
    expect(result.exampleMessages).toEqual([]);
  });

  it("uses an Agent preset only when roleplay is enabled", () => {
    const snapshot = fixture();
    const roleplay = defaultRoleplayConfig(true);
    const preset = roleplay.presets[0]!;
    preset.blocks = [
      { ...preset.blocks.find((block) => block.kind === "main")!, order: 0, content: "Preset {{original}}" },
      { ...preset.blocks.find((block) => block.kind === "history")!, order: 1 },
      { ...preset.blocks.find((block) => block.kind === "author_note")!, order: 2, position: "in_chat", depth: 0 }
    ];
    snapshot.roleplay = roleplay;
    snapshot.roleplayState = {
      ...snapshot.roleplayState,
      presetId: preset.id,
      authorNote: "Remember the lantern"
    };
    const result = compileAgentPrompt(snapshot, []);
    expect(result.systemPrompt).toContain("Preset Rules for Mira: BASE");
    expect(result.inChatMessages).toEqual([{
      depth: 0,
      message: { role: "user", text: "[作者注释]\nRemember the lantern" }
    }]);
  });

  it("composes ordered roleplay sections, personas, lore, and non-system messages", () => {
    const snapshot = fixture();
    const roleplay = defaultRoleplayConfig(true);
    roleplay.personas = [{ id: "hero", name: "Ari", description: "Brave", avatarAssetId: null }];
    roleplay.defaultPersonaId = "hero";
    roleplay.lorebooks = [{
      id: "extra", name: "Extra", enabled: true,
      book: { entries: [{
        id: "lore", keys: ["moon"], content: "Moon lore", extensions: {}, enabled: true,
        insertion_order: 1, position: "after_examples"
      }], extensions: {} }
    }];
    const preset = roleplay.presets[0]!;
    preset.blocks.push(
      {
        id: "before-user", name: "Before user", kind: "custom", enabled: true, role: "user",
        position: "relative", depth: 0, order: 5, triggers: ["normal"], content: "Before history"
      },
      {
        id: "after-assistant", name: "After assistant", kind: "custom", enabled: true, role: "assistant",
        position: "relative", depth: 0, order: 20, triggers: ["normal"], content: "After history"
      },
      {
        id: "ignored", name: "Ignored", kind: "custom", enabled: false, role: "system",
        position: "relative", depth: 0, order: 21, triggers: ["normal"], content: "Never"
      }
    );
    snapshot.roleplay = roleplay;
    snapshot.roleplayState = {
      ...snapshot.roleplayState,
      presetId: preset.id,
      personaId: "hero",
      scenarioOverride: "Moon base",
      enabledLorebookIds: ["extra"]
    };
    const result = compileAgentPrompt(snapshot, [{
      messageId: "moon", ordinal: 1, role: "user", text: "Look at the moon"
    }]);

    expect(result.systemPrompt).toContain("Moon base");
    expect(result.systemPrompt).toContain("名称：Ari");
    expect(result.systemPrompt).toContain("Moon lore");
    expect(result.exampleMessages).toHaveLength(2);
    expect(result.beforeHistoryMessages).toEqual([{ role: "user", text: "Before history" }]);
    expect(result.afterHistoryMessages).toEqual([{ role: "assistant", text: "After history" }]);
    expect(result.postHistoryInstructions).toContain("Stay in character as Mira");
    expect(result.postHistoryInstructions).not.toContain("Never");
  });

  it("renders deterministic macros and applies safe world-info regex only when explicitly enabled", () => {
    const snapshot = fixture();
    const roleplay = defaultRoleplayConfig(true);
    roleplay.lorebooks = [{
      id: "macro-book", name: "Macro book", enabled: true,
      book: { extensions: {}, entries: [{
        keys: [], constant: true, enabled: true, insertion_order: 0, extensions: {},
        content: "PRIVATE {{var::place}} {{random:north::south}}", position: "before_char"
      }] }
    }];
    roleplay.regexScripts = [{
      id: "hide-private", name: "Hide private", enabled: true, pattern: "PRIVATE\\s+", replacement: "",
      flags: "gu", scopes: ["world_info"], runOnEdit: false, importWarning: null
    }];
    snapshot.roleplay = roleplay;
    snapshot.roleplayState = {
      ...snapshot.roleplayState,
      presetId: roleplay.defaultPresetId,
      variables: { place: "archive" },
      enabledLorebookIds: ["macro-book"],
      enabledRegexScriptIds: ["hide-private"]
    };
    const history = [{ messageId: "turn", ordinal: 1, role: "user" as const, text: "begin" }];
    const first = compileAgentPrompt(snapshot, history);
    const second = compileAgentPrompt(snapshot, history);
    expect(first.systemPrompt).toContain("archive");
    expect(first.systemPrompt).not.toContain("PRIVATE");
    expect(second.systemPrompt).toBe(first.systemPrompt);
  });
});

function fixture(): AgentSnapshot {
  return {
    agentId: "agent", name: "Mira", revision: 3, baseSystemPrompt: "BASE",
    workspacePath: null, extensionsPinned: false, skillRevisions: {}, toolRevisions: {},
    generationKind: "normal",
    roleplay: {
      enabled: false, presets: [], defaultPresetId: null, personas: [], defaultPersonaId: null,
      lorebooks: [], regexScripts: [], quickReplySets: [], assets: []
    },
    roleplayState: {
      presetId: null, personaId: null, authorNote: "", scenarioOverride: "", variables: {},
      enabledLorebookIds: [], enabledRegexScriptIds: [], enabledQuickReplySetIds: [],
      backgroundAssetId: null, expressionAssetId: null
    },
    userProfile: { displayName: "Lin", description: "A careful tester" },
    execution: {
      modelId: "model", visionModelId: null, search: { provider: "searxng", baseUrl: "" }, contextPolicy: "trim", reasoningEffort: "none",
      settings: { common: { maxOutputTokens: 100, stopSequences: [] }, protocol: {}, reasoningEffort: "none" },
      tools: { defaultEnabled: true, overrides: {}, approvalOverrides: {} },
      enabledSkillIds: [], maxToolRounds: 32, maxBackgroundTasks: 2, taskLogLimitBytes: 64 * 1024 * 1024
    },
    card: { spec: "chara_card_v2", spec_version: "2.0", data: {
      name: "Mira", description: "Archivist", personality: "Precise", scenario: "Archive",
      first_mes: "Hello {{user}}", alternate_greetings: [],
      mes_example: "<START>\n{{user}}: Hello {{char}}\n{{char}}: Hello {{user}}",
      creator_notes: "creator only", system_prompt: "Rules for {{char}}: {{original}}",
      post_history_instructions: "Stay in character as {{char}}.", tags: ["test"], creator: "creator",
      character_version: "1", extensions: {},
      character_book: { entries: [
        { keys: ["red key"], content: "Before lore for {{user}}", extensions: {}, enabled: true, insertion_order: 1, position: "before_char" },
        { keys: ["archive"], content: "After lore for {{char}}", extensions: {}, enabled: true, insertion_order: 2, position: "after_char" }
      ], extensions: {} }
    } }
  };
}
