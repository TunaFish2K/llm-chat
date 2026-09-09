import { join } from "node:path";
import { Store } from "./database";
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
  it("remembers a selection independently and freezes it only into new conversations", () => {
    const store = createStore();
    const { model } = seedModel(store);
    const second = store.createModel({ ...model, modelKey: "second", displayName: "Second" });
    const original = store.getAgent(store.getSettings().defaultAgentId)!;
    const agent = store.createAgent({ card: original.card, execution: { ...original.execution, modelId: null }, userProfile: {} });
    expect(store.newConversationOverrides(agent.id)).toEqual({});
    const selected = store.rememberAgentModel(agent.id, model.id);
    expect(selected).toMatchObject({ lastSelectedModelId: model.id, revision: agent.revision, execution: { modelId: null } });
    const first = store.createConversation({ agentId: agent.id });
    expect(first).toMatchObject({ modelId: model.id, executionOverrides: { modelId: model.id } });
    store.rememberAgentModel(agent.id, second.id);
    expect(store.getConversation(first.id)?.modelId).toBe(model.id);
    expect(store.createConversation({ agentId: agent.id }).modelId).toBe(second.id);
    expect(store.createConversation({ agentId: agent.id, executionOverrides: { modelId: null } }).modelId).toBeNull();
    expect(store.createConversation({ agentId: agent.id, executionOverrides: { modelId: model.id } }).modelId).toBe(model.id);
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBe(second.id);
    store.updateAgent(agent.id, { execution: { ...agent.execution, modelId: model.id } });
    expect(store.createConversation({ agentId: agent.id }).modelId).toBe(model.id);
    expect(store.getAgent(original.id)?.lastSelectedModelId).toBeNull();
  });

  it("records explicit conversation changes but not unrelated patches, and rejects unavailable models", () => {
    const store = createStore(); const { model } = seedModel(store);
    const second = store.createModel({ ...model, modelKey: "second", displayName: "Second" });
    const agent = store.getAgent(store.getSettings().defaultAgentId)!;
    const conversation = store.createConversation({ agentId: agent.id });
    store.updateConversation(conversation.id, { modelId: model.id });
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBe(model.id);
    store.rememberAgentModel(agent.id, second.id);
    store.updateConversation(conversation.id, { draft: "draft", executionOverrides: { modelId: model.id, reasoningEffort: "low" } });
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBe(second.id);
    store.updateConversation(conversation.id, { modelId: model.id });
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBe(model.id);
    store.updateConversation(conversation.id, { executionOverrides: { modelId: second.id } });
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBe(second.id);
    store.updateAgent(agent.id, { execution: { ...agent.execution, modelId: null } });
    store.updateModel(second.id, { enabled: false });
    expect(store.createConversation({ agentId: agent.id }).modelId).toBeNull();
    expect(() => store.rememberAgentModel(agent.id, second.id)).toThrow("停用");
    expect(() => store.updateConversation(conversation.id, { title: "changed", modelId: second.id })).toThrow("停用");
    expect(store.getConversation(conversation.id)?.title).toBe(conversation.title);
    store.deleteModel(second.id);
    expect(store.getAgent(agent.id)?.lastSelectedModelId).toBeNull();
    expect(() => store.rememberAgentModel(agent.id, second.id)).toThrow("模型不存在");
    expect(() => store.rememberAgentModel("missing", model.id)).toThrow("Agent 不存在");
    expect(() => store.newConversationOverrides("missing")).toThrow("Agent 不存在");
  });

  it("retains model memory after reopening the database", () => {
    const store = createStore(); const { model } = seedModel(store);
    const id = store.getSettings().defaultAgentId;
    store.rememberAgentModel(id, model.id);
    const file = join(store.dataDir, "test.sqlite");
    store.close();
    const reopened = new Store(file);
    try { expect(reopened.getAgent(id)?.lastSelectedModelId).toBe(model.id); }
    finally { reopened.close(); }
  });

});
