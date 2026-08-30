import type { AgentSnapshot, ContextMessageRecord } from "./database";
import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "./agent-prompt";

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
});

function fixture(): AgentSnapshot {
  return {
    agentId: "agent", name: "Mira", revision: 3, baseSystemPrompt: "BASE",
    workspacePath: null, extensionsPinned: false, skillRevisions: {}, toolRevisions: {},
    userProfile: { displayName: "Lin", description: "A careful tester" },
    execution: {
      modelId: "model", contextPolicy: "trim", reasoningEffort: "none",
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
