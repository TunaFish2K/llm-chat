import { afterEach, expect, it } from "vitest";
import { resolveModelProtocol } from "@llm-chat/contracts";
import { Store } from "./database";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);

it("resolves manual, detected, exact Go mapping and connection defaults in order", () => {
 const go = { providerId: "opencode-go" as const };
 expect(resolveModelProtocol({ modelKey: "grok-4.6" }, go)).toBe("openai-responses");
 expect(resolveModelProtocol({ modelKey: "grok-4.6", detectedProtocol: "anthropic-messages" }, go)).toBe("anthropic-messages");
 expect(resolveModelProtocol({ modelKey: "grok-4.6", protocol: "openai-chat", detectedProtocol: "anthropic-messages" }, go)).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "future-grok" }, go)).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "grok-4.6" }, { ...go, providerId: "custom" })).toBe("openai-chat");
 expect(resolveModelProtocol({ modelKey: "unknown", detectedProtocol: "anthropic-messages" }, { providerId: "openai" })).toBe("openai-responses");
 expect(resolveModelProtocol({ modelKey: "claude-sonnet-4-5" }, { providerId: "custom" })).toBe("anthropic-messages");
 expect(resolveModelProtocol({ modelKey: "gpt-5.4" }, { providerId: "custom" })).toBe("openai-responses");
 expect(resolveModelProtocol({ modelKey: "deepseek-chat" }, { providerId: "deepseek" })).toBe("openai-chat");
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
 expect(() => store.updateConnection(connection.id, { providerId: "openai" })).toThrow();
 store.updateModel(model.id, { protocol: null });
 store.updateConnection(connection.id, { providerId: "openai" });
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
  expect(migrated.getModel(model.id)).toMatchObject({ protocol: null, detectedProtocol: "openai-chat" });
  expect(migrated.getGenerationRecord(started.generation.generationId)?.protocol).toBe("openai-chat");
  expect(migrated.listMessages(started.conversation.id).some(m => m.text === "history")).toBe(true);
  expect(migrated.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 51 });
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

it("backfills custom relay protocols and fuzzy catalog reasoning levels in v48 without touching manual values", () => {
 const store = createStore(); const { model } = seedModel(store);
 const claude = store.createModel({ ...model, modelKey: "claude-sonnet-4-5", protocol: "openai-chat", reasoningEffortsOverride: ["high"] });
 const metadata = { providerId: "openai", modelId: "gpt-5.4", inputModalities: ["text"], outputModalities: ["text"], reasoningEfforts: ["low", "high"], fetchedAt: 1 };
 store.restoreCatalogModel(model.id, model, metadata);
 const path = (store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file;
 store.sqlite.exec("UPDATE models SET detected_protocol = NULL, detected_reasoning_efforts_json = NULL; PRAGMA user_version = 47");
 store.close();
 const migrated = new Store(path);
 try {
  expect(migrated.getModel(model.id)).toMatchObject({ detectedProtocol: "openai-chat", detectedReasoningEfforts: ["low", "high"] });
  expect(migrated.getModel(claude.id)).toMatchObject({ protocol: "openai-chat", detectedProtocol: "anthropic-messages", reasoningEffortsOverride: ["high"] });
 } finally {
  migrated.close();
 }
});

it("pins the retired connection protocol in v49 only where automatic resolution would change", () => {
 const store = createStore(); const { model, connection } = seedModel(store);
 const claude = store.createModel({ ...model, modelKey: "claude-sonnet-4-5" });
 const manual = store.createModel({ ...model, modelKey: "gpt-5.4", protocol: "openai-chat" });
 const openai = store.createConnection({ name: "OpenAI", providerId: "openai", baseUrl: "https://api.openai.com/v1", secretHeaders: {} });
 const chat = store.createModel({ ...model, connectionId: openai.id, modelKey: "gpt-5.4" });
 const path = (store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file;
 store.sqlite.exec(`UPDATE models SET detected_protocol = NULL;
  UPDATE connections SET protocol = 'openai-chat';
  PRAGMA user_version = 48`);
 store.close();
 const migrated = new Store(path);
 try {
  expect(migrated.getModel(model.id)?.protocol).toBeNull();
  expect(migrated.getModel(claude.id)?.protocol).toBe("openai-chat");
  expect(migrated.getModel(manual.id)?.protocol).toBe("openai-chat");
  expect(migrated.getModel(chat.id)?.protocol).toBe("openai-chat");
  expect(migrated.getConnection(connection.id)).toMatchObject({ protocol: "openai-chat" });
  expect(migrated.listConnections()[0]).not.toHaveProperty("protocol");
 } finally {
  migrated.close();
 }
});
