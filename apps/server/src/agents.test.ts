import { afterEach, describe, expect, it } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

describe("Agent storage and conversation selection", () => {
  afterEach(cleanupStores);

  it("snapshots revisions, writes the selected greeting, clears overrides on switch, and detaches on delete", () => {
    const store = createStore();
    const { model } = seedModel(store);
    store.updateSettings({ userProfile: { displayName: "Lin", description: "" } });
    const defaultAgent = store.getAgent(store.getSettings().defaultAgentId)!;
    const first = store.createAgent({
      card: { ...defaultAgent.card, data: {
        ...defaultAgent.card.data, name: "Mira", first_mes: "First {{user}}", alternate_greetings: ["Alt {{user}}"]
      } },
      execution: { ...defaultAgent.execution, modelId: model.id },
      userProfile: {}
    });
    const second = store.createAgent({
      card: { ...defaultAgent.card, data: { ...defaultAgent.card.data, name: "Work", first_mes: "Work greeting" } },
      execution: { ...defaultAgent.execution, modelId: model.id }, userProfile: {}
    });

    const started = store.startConversation({
      text: "Hello", agentId: first.id, greetingIndex: 1,
      executionOverrides: { contextPolicy: "full", tools: { get_time_info: false } }
    });
    const messages = store.listMessages(started.conversation.id);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["assistant", "Alt Lin"], ["user", "Hello"], ["assistant", null]
    ]);
    const generation = store.getGeneration(started.generation.generationId)!;
    expect(generation.generatedAgent).toMatchObject({ agentId: first.id, name: "Mira", revision: 1 });

    const updated = store.updateAgent(first.id, { card: { ...first.card, data: { ...first.card.data, personality: "Changed" } } })!;
    expect(updated.revision).toBe(2);
    expect(store.getGeneration(started.generation.generationId)?.generatedAgent?.revision).toBe(1);
    const next = store.createMessageGeneration(started.conversation.id, "Again");
    expect(store.getGeneration(next.generationId)?.generatedAgent?.revision).toBe(2);

    const switched = store.updateConversation(started.conversation.id, { agentId: second.id })!;
    expect(switched.agentId).toBe(second.id);
    expect(switched.executionOverrides).toEqual({});
    expect(store.listMessages(switched.id)).toHaveLength(5);
    store.updateSettings({ defaultAgentId: second.id, lastAgentId: second.id });
    expect(store.deleteAgent(second.id)).toBe(true);
    expect(store.getSettings()).toMatchObject({ defaultAgentId: defaultAgent.id, lastAgentId: defaultAgent.id });
    expect(store.getConversation(switched.id)?.agentId).toBeNull();
    expect(() => store.createMessageGeneration(switched.id, "Blocked")).toThrow("选择 Agent");
    expect(() => store.deleteAgent(defaultAgent.id)).toThrow("不能删除");
  });
});
