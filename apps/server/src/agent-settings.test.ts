import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./database";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./generation-policy";
import { compileAgentPrompt } from "./agent-prompt";
import { exportCharacterCardWithAssets, importCharacterCard } from "./character-card";
import { ImageService } from "./images";
import { defaultRoleplayConfig } from "./roleplay";
import { cleanupStores, createStore, seedModel, updateDefaultAgentExecution } from "./test-helpers";

afterEach(cleanupStores);

describe("Agent-owned generation settings", () => {
  it.each(["", "Legacy {{char}} {{user}} {{random:a::b}} $&\nbase"])("migrates legacy prompts without changing compilation: %j", (baseSystemPrompt) => {
    const original = createStore();
    const { model } = seedModel(original);
    const initial = updateDefaultAgentExecution(original, { baseSystemPrompt, contextPolicy: "trim", reasoningEffort: "none", modelId: null });
    original.rememberAgentModel(initial.id, model.id);
    const agents = [initial, ...["", "Own instructions", "Rules {{char}}: {{original}}"].map((system_prompt, index) => original.createAgent({
      card: { ...initial.card, data: { ...initial.card.data, name: `Agent ${index}`, system_prompt } },
      execution: { ...initial.execution, modelId: model.id }, userProfile: {}, roleplay: defaultRoleplayConfig(index === 2)
    }))];
    original.updateSettings({ defaultAgentId: agents[2]!.id });
    const expected = agents.map((agent) => {
      const started = original.startConversation({ agentId: agent.id, greetingIndex: 0, text: "Hello" });
      const snapshot = original.getGenerationRecord(started.generation.generationId)!.agentSnapshot;
      original.finishGeneration(started.generation.generationId, "completed", {});
      return { agent, conversation: started.conversation, generationId: started.generation.generationId, snapshot,
        prompt: compileAgentPrompt(snapshot, []) };
    });
    original.sqlite.prepare("UPDATE app_settings SET default_system_prompt = ?, default_model_id = ?, default_context_policy = 'full', reasoning_effort = 'high'")
      .run(baseSystemPrompt, model.id);
    for (const agent of agents) {
      const { baseSystemPrompt: _legacy, ...execution } = agent.execution;
      original.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?").run(JSON.stringify(execution), agent.id);
    }
    original.sqlite.exec("PRAGMA user_version = 35");
    const path = join(original.dataDir, "test.sqlite");
    original.close();
    const migrated = new Store(path);
    try {
      expect(migrated.getSettings().defaultAgentId).toBe(agents[2]!.id);
      for (const item of expected) {
        const agent = migrated.getAgent(item.agent.id)!;
        expect(agent.execution).toEqual(item.agent.execution);
        expect(agent.card).toEqual(item.agent.card);
        expect(agent.revision).toBe(item.agent.revision + 1);
        expect(compileAgentPrompt(migrated.resolveGeneration(item.conversation).snapshot, [])).toEqual(item.prompt);
        expect(migrated.getGenerationRecord(item.generationId)!.agentSnapshot).toEqual(item.snapshot);
      }
      expect(migrated.getAgent(initial.id)?.lastSelectedModelId).toBe(model.id);
      expect(migrated.createConversation({ agentId: initial.id }).modelId).toBe(model.id);
      updateDefaultAgentExecution(migrated, { baseSystemPrompt: "Only the selected Agent changes" });
      expect(migrated.getAgent(initial.id)?.execution.baseSystemPrompt).toBe(baseSystemPrompt);
    } finally { migrated.close(); }
    const reopened = new Store(path);
    try {
      expect(reopened.getAgent(initial.id)?.revision).toBe(initial.revision + 1);
      expect(reopened.getAgent(agents[2]!.id)?.execution.baseSystemPrompt).toBe("Only the selected Agent changes");
    } finally { reopened.close(); }
  });

  it("preserves absent update fields, explicit empty prompts, and portable prompts", async () => {
    const store = createStore();
    const initial = store.getAgent(store.getSettings().defaultAgentId)!;
    const { baseSystemPrompt: _base, ...execution } = initial.execution;
    const agent = store.createAgent({ card: initial.card, execution, userProfile: {} });
    expect(agent.execution.baseSystemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    store.updateAgent(agent.id, { execution: { ...execution, baseSystemPrompt: "Custom base" } });
    expect(store.updateAgent(agent.id, { execution })?.execution.baseSystemPrompt).toBe("Custom base");
    store.setAgentAvatar(agent.id, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const files = new ImageService(store);
    for (const baseSystemPrompt of ["Custom base", ""]) {
      const updated = store.updateAgent(agent.id, { execution: { ...execution, baseSystemPrompt } })!;
      for (const format of ["json", "png", "charx"] as const) {
        const exported = await exportCharacterCardWithAssets(store, files, updated, format);
        const imported = importCharacterCard(store, `agent.${format}`, exported.bytes);
        expect(imported.execution.baseSystemPrompt).toBe(baseSystemPrompt);
      }
    }
  });
});
