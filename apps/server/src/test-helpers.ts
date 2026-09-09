import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, ModelSettings } from "@llm-chat/contracts";
import { Store } from "./database";

const storeDirs: string[] = [];
const stores: Store[] = [];

export function cleanupStores(): void {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch {}
  }
  for (const dir of storeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function createStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-test-"));
  storeDirs.push(dir);
  const store = new Store(join(dir, "test.sqlite"));
  stores.push(store);
  return store;
}

export function seedModel(store: Store) {
  const connection = store.createConnection({
    name: "Mock", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {}
  });
  const settings: ModelSettings = { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {} };
  const input: ModelInput = {
    connectionId: connection.id,
    modelKey: "mock-model",
    displayName: "Mock Model",
    contextWindow: 2048,
    maxOutputTokens: 128,
    capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
    defaultSettings: settings,
    enabled: true
  };
  const model = store.createModel(input);
  updateDefaultAgentExecution(store, { modelId: model.id });
  return { connection, model, settings };
}

export function updateDefaultAgentExecution(store: Store, patch: Partial<import("@llm-chat/contracts").AgentExecutionConfig>) {
  const agent = store.getAgent(store.getSettings().defaultAgentId)!;
  return store.updateAgent(agent.id, { execution: { ...agent.execution, ...patch } })!;
}
