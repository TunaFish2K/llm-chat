import { afterEach, expect, it } from "vitest";
import { resolveModelProtocol } from "@llm-chat/contracts";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);

it("resolves manual, detected, exact Go mapping and connection defaults in order", () => {
 const go = { providerId: "opencode-go" as const, protocol: "openai-chat" as const };
 expect(resolveModelProtocol({ modelKey: "grok-4.6" }, go)).toBe("openai-responses");
 expect(resolveModelProtocol({ modelKey: "grok-4.6", detectedProtocol: "anthropic-messages" }, go)).toBe("anthropic-messages");
 expect(resolveModelProtocol({ modelKey: "grok-4.6", protocol: "openai-chat", detectedProtocol: "anthropic-messages" }, go)).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "future-grok" }, go)).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "grok-4.6" }, { ...go, providerId: "custom" })).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "unknown", detectedProtocol: "anthropic-messages" }, { providerId: "openai", protocol: "openai-responses" })).toBe("openai-responses");
});

it("refreshes detection independently of metadata management and preserves manual protocols", () => {
 const store = createStore(); const { model, connection } = seedModel(store);
 const metadata = { providerId: "custom", modelId: model.modelKey, inputModalities: ["text"], outputModalities: ["text"], reasoningEfforts: [], fetchedAt: 1 };
 const managed = store.restoreCatalogModel(model.id, model, metadata)!;
 expect(managed.catalogManaged).toBe(true);
 expect(store.updateModel(model.id, { protocol: "openai-responses" })).toMatchObject({ protocol: "openai-responses", catalogManaged: true });
 store.updateModel(model.id, { contextWindow: 8192 });
 store.upsertDiscoveredModel({ ...model, detectedProtocol: "anthropic-messages" }, metadata);
 expect(store.getModel(model.id)).toMatchObject({ protocol: "openai-responses", detectedProtocol: "anthropic-messages", contextWindow: 8192, catalogManaged: false });
 store.upsertDiscoveredModel({ ...model, detectedProtocol: null }, null);
 expect(store.getModel(model.id)?.detectedProtocol).toBe("anthropic-messages");
 store.updateModel(model.id, { enabled: false });
 expect(store.getModel(model.id)?.protocol).toBe("openai-responses");
 store.createModel({ ...model, protocol: undefined });
 expect(store.getModel(model.id)?.protocol).toBe("openai-responses");
 store.updateModel(model.id, { protocol: null });
 expect(resolveModelProtocol(store.getModel(model.id)!, connection)).toBe("anthropic-messages");
 store.updateModel(model.id, { modelKey: "renamed" });
 expect(store.getModel(model.id)?.detectedProtocol).toBeNull();
 store.upsertDiscoveredModel({ ...store.getModel(model.id)!, detectedProtocol: "anthropic-messages" }, null);
 store.updateConnection(connection.id, { baseUrl: "https://new.example/v1" });
 expect(store.getModel(model.id)?.detectedProtocol).toBeNull();
});

it("rejects unsupported manual protocols for model and connection updates", () => {
 const store = createStore(); const { model, connection } = seedModel(store);
 store.updateModel(model.id, { protocol: "anthropic-messages" });
 expect(() => store.updateConnection(connection.id, { providerId: "openai", protocol: "openai-responses" })).toThrow();
 store.updateModel(model.id, { protocol: null });
 store.updateConnection(connection.id, { providerId: "openai", protocol: "openai-responses" });
 expect(() => store.updateModel(model.id, { protocol: "anthropic-messages" })).toThrow();
});

it("migrates v41 models without changing IDs, history or generation protocol snapshots", () => {
 const store = createStore(); const { model } = seedModel(store);
 const started = store.startConversation({ text: "history", modelId: model.id });
 const path = (store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file;
 store.sqlite.exec("ALTER TABLE models DROP COLUMN protocol; ALTER TABLE models DROP COLUMN detected_protocol; PRAGMA user_version = 41");
 store.close();
 const migrated = new Store(path);
 try {
  expect(migrated.getModel(model.id)).toMatchObject({ protocol: null, detectedProtocol: null });
  expect(migrated.getGenerationRecord(started.generation.generationId)?.protocol).toBe("openai-chat");
  expect(migrated.listMessages(started.conversation.id).some(m => m.text === "history")).toBe(true);
  expect(migrated.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 43 });
 } finally { migrated.close(); }
});

it("refreshes native efforts independently of catalog management and preserves overrides", () => {
 const store = createStore(); const { model, connection } = seedModel(store);
 store.updateModel(model.id, { reasoningEffortsOverride: ["minimal", "none"] });
 store.upsertDiscoveredModel({ ...model, detectedReasoningEfforts: ["high", "max"] }, null);
 expect(store.getModel(model.id)).toMatchObject({ reasoningEffortsOverride: ["minimal", "none"], detectedReasoningEfforts: ["high", "max"], catalogManaged: false });
 store.upsertDiscoveredModel({ ...model, detectedReasoningEfforts: null }, null);
 expect(store.getModel(model.id)?.detectedReasoningEfforts).toEqual(["high", "max"]);
 store.updateModel(model.id, { enabled: true });
 expect(store.getModel(model.id)?.reasoningEffortsOverride).toEqual(["minimal", "none"]);
 store.updateModel(model.id, { reasoningEffortsOverride: null });
 store.updateConnection(connection.id, { baseUrl: "https://changed.test/v1" });
 expect(store.getModel(model.id)).toMatchObject({ reasoningEffortsOverride: null, detectedReasoningEfforts: null });
});
