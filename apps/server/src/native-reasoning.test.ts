import { afterEach, expect, it } from "vitest";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { effectiveReasoningSelection, modelReasoningOptions, providerReasoningEffort } from "@llm-chat/contracts";

afterEach(cleanupStores);

it("migrates exact directory efforts while preserving historical requests and legacy none", () => {
 const store = createStore(); const { model, connection } = seedModel(store);
 store.updateConnection(connection.id, { providerId: "opencode-go" });
 const updated = store.updateModel(model.id, { modelKey: "grok-4.6", capabilities: { ...model.capabilities, reasoning: true } })!;
 store.restoreCatalogModel(model.id, updated, { providerId: "opencode-go", modelId: "grok-4.6", inputModalities: [], outputModalities: [], reasoningEfforts: ["minimal", "none", "xhigh"], fetchedAt: 1 });
 const started = store.startConversation({ text: "old history", modelId: model.id });
 const oldGeneration = store.getGeneration(started.generation.generationId);
 const path = (store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file;
 store.sqlite.exec("ALTER TABLE models DROP COLUMN reasoning_efforts_override_json; ALTER TABLE models DROP COLUMN detected_reasoning_efforts_json; PRAGMA user_version = 42");
 store.close();
 const migrated = new Store(path);
 try {
  expect(migrated.getModel(model.id)).toMatchObject({ reasoningEffortsOverride: null, detectedReasoningEfforts: ["minimal", "none", "xhigh"] });
  expect(migrated.getGeneration(started.generation.generationId)).toEqual(oldGeneration);
  expect(providerReasoningEffort(migrated.getGeneration(started.generation.generationId)!.settings)).toBeNull();
 } finally { migrated.close(); }
});

it("preserves structured choices and blocks stale agent/conversation edits", () => {
 const store = createStore(); const { model } = seedModel(store);
 store.updateModel(model.id, { capabilities: { ...model.capabilities, reasoning: true }, reasoningEffortsOverride: ["minimal", "none"] });
 const original = store.getAgent(store.getSettings().defaultAgentId)!;
 const agent = store.updateAgent(original.id, { execution: { ...original.execution, reasoningSelection: { mode: "effort", value: "none" } } })!;
 expect(() => store.updateAgent(original.id, { execution: original.execution })).toThrow("刷新");
 store.updateAgent(agent.id, { userProfile: { description: "updated" } });
 const started = store.startConversation({ text: "native none", agentId: agent.id, greetingIndex: 0 });
 expect(providerReasoningEffort(store.getGeneration(started.generation.generationId)!.settings)).toBe("none");
 store.finishGeneration(started.generation.generationId, "completed", {});
 store.updateConversation(started.conversation.id, { executionOverrides: { reasoningSelection: { mode: "default" } } });
 expect(() => store.updateConversation(started.conversation.id, { executionOverrides: { reasoningEffort: "max" } })).toThrow("刷新");
 expect(providerReasoningEffort(store.getGeneration(store.createMessageGeneration(started.conversation.id, "default").generationId)!.settings)).toBeNull();
 store.updateConversation(started.conversation.id, { executionOverrides: {} });
 expect(effectiveReasoningSelection(agent.execution, store.getConversation(started.conversation.id)!.executionOverrides)).toEqual({ mode: "effort", value: "none" });
 expect(modelReasoningOptions(store.getModel(model.id)).values).toEqual(["minimal", "none"]);
});

it.each([false, true])("adapts queue dispatch and retries without replacing preferences or historical snapshots (override: %s)", (explicit) => {
 const store = createStore(); const { model } = seedModel(store);
 store.updateModel(model.id, { capabilities: { ...model.capabilities, reasoning: true }, reasoningEffortsOverride: ["low", "xhigh"] });
 const full = store.createModel({ ...model, modelKey: "full-levels", displayName: "Full levels",
   capabilities: { ...model.capabilities, reasoning: true }, reasoningEffortsOverride: ["low", "high", "max"] });
 const original = store.getAgent(store.getSettings().defaultAgentId)!;
 const preference = { mode: "effort", value: "max" } as const;
 store.updateAgent(original.id, { execution: { ...original.execution, reasoningSelection: preference } });
 const started = store.startConversation({ text: "first", agentId: original.id, greetingIndex: 0,
   executionOverrides: explicit ? { reasoningSelection: preference } : {} });
 const settings = (id: string) => store.getGeneration(id)!.settings;
 expect(providerReasoningEffort(settings(started.generation.generationId))).toBe("xhigh");
 const firstSettings = structuredClone(settings(started.generation.generationId));
 store.enqueueMessage(started.conversation.id, "queued", []);
 store.updateConversation(started.conversation.id, { modelId: full.id });
 store.finishGeneration(started.generation.generationId, "completed", {});
 const queued = store.dispatchQueuedMessage(started.conversation.id, () => {})!;
 expect(queued).toBeTruthy();
 expect(providerReasoningEffort(settings(queued.generationId))).toBe("max");
 store.finishGeneration(queued.generationId, "completed", {});
 store.updateConversation(started.conversation.id, { modelId: model.id });
 const retry = store.createRetryGeneration(queued.assistantMessageId);
 expect(providerReasoningEffort(settings(retry.generationId))).toBe("xhigh");
 expect(settings(started.generation.generationId)).toEqual(firstSettings);
 expect(providerReasoningEffort(settings(queued.generationId))).toBe("max");
 expect(store.getAgent(original.id)!.execution.reasoningSelection).toEqual(preference);
 expect(store.getConversation(started.conversation.id)!.executionOverrides.reasoningSelection).toEqual(explicit ? preference : undefined);
});

it("reads a saved manual Thinking approval snapshot without reinterpreting its budget or effort", () => {
 const store = createStore(); const { model } = seedModel(store);
 const started = store.startConversation({ text: "historical", modelId: model.id });
 const record = store.getGenerationRecord(started.generation.generationId)!;
 const legacySettings = { ...record.settings, reasoningEffort: "high" as const, resolvedThinkingBudgetTokens: 2048 };
 delete legacySettings.reasoningSelection;
 const snapshot = structuredClone(record.agentSnapshot);
 snapshot.execution.reasoningEffort = "high";
 snapshot.execution.settings = legacySettings;
 delete snapshot.execution.reasoningSelection;
 store.sqlite.prepare("UPDATE generations SET settings_json = ?, agent_snapshot_json = ? WHERE id = ?")
   .run(JSON.stringify(legacySettings), JSON.stringify(snapshot), record.id);
 store.setGenerationWaitingApproval(record.id);
 store.updateModel(model.id, { reasoningEffortsOverride: ["low"], capabilities: { ...model.capabilities, reasoning: true } });
 expect(store.getGenerationRecord(record.id)).toMatchObject({
   status: "waiting-approval", settings: legacySettings, agentSnapshot: { execution: { settings: legacySettings } }
 });
 expect(store.getGeneration(record.id)!.settings).toEqual(legacySettings);
});
