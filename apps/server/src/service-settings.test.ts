import { afterEach, expect, it, vi } from "vitest";
import { ServiceSettings } from "./service-settings";
import { migrateServiceSettings } from "./service-settings-migration";
import { buildServerTools } from "./tools";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => { cleanupStores(); vi.unstubAllGlobals(); });

it("orders search recommendations, hides secrets, and enforces disablement at execution", async () => {
  const store = createStore(); const services = new ServiceSettings(store);
  const settings = services.update({ searchEngines: [
    { id: "tavily", provider: "tavily", enabled: true, baseUrl: "", apiKey: "private-key" },
    { id: "searxng", provider: "searxng", enabled: true, baseUrl: "https://search.test" }
  ] });
  expect(JSON.stringify(settings)).not.toContain("private-key");
  const search = (await buildServerTools(store)).find((tool) => tool.definition.name === "search_web")!;
  expect(JSON.parse(await search.execute({ action: "list_engines" }, new AbortController().signal)).engines.map((item: { id: string }) => item.id)).toEqual(["tavily", "searxng"]);
  const fetch = vi.fn(async (_url: unknown) => Response.json({ results: [] })); vi.stubGlobal("fetch", fetch);
  await search.execute({ query: "hello" }, new AbortController().signal);
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
  services.update({ searchEngines: settings.searchEngines.map((item) => ({ ...item, enabled: false })) });
  await expect(search.execute({ query: "hello", engine_id: "tavily" }, new AbortController().signal)).rejects.toThrow("No matching enabled search engine");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(services.engines()[0]?.apiKey).toBe("private-key");
});

it("preserves readable handles through rename/reorder and resolves them to internal model IDs", async () => {
  const store = createStore(); const a = seedModel(store); const b = seedModel(store);
  for (const { model } of [a, b]) store.updateModel(model.id, { capabilities: { ...model.capabilities, imageOutput: true }, imageProtocol: "openai-images" });
  const services = new ServiceSettings(store); const initial = services.images();
  expect(new Set(initial.map((item) => item.id)).size).toBe(2);
  const reordered = services.update({ imageModels: initial.toReversed().map((item) => ({ modelId: item.modelId, enabled: true })) }).imageModels;
  store.updateModel(a.model.id, { displayName: "Changed" });
  expect(services.images().map((item) => item.id)).toEqual(reordered.map((item) => item.id));
  const createAndWait = vi.fn(async () => ({ id: "job", status: "completed", outputAssets: [] }));
  const image = (await buildServerTools(store, false, { imageManager: { createAndWait } as never })).find((tool) => tool.definition.name === "image_generate")!;
  expect(await image.requiresApproval({ action: "list_models" })).toBe(false);
  await image.execute({ model_id: reordered[0]!.id, prompt: "coast" }, new AbortController().signal, { conversationId: "conversation", toolCallId: "call" } as never);
  expect(createAndWait).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ modelId: reordered[0]!.modelId }) }), expect.any(AbortSignal));
  services.update({ imageModels: [{ modelId: reordered[0]!.modelId, enabled: false }] });
  await expect(image.execute({ model_id: reordered[0]!.modelId, prompt: "coast" }, new AbortController().signal, {} as never)).rejects.toThrow("No matching enabled image model");
});

it("deduplicates legacy service credentials without overwriting subsequent global settings", () => {
  const store = createStore(); const agent = store.getAgent(store.getSettings().defaultAgentId)!;
  store.updateAgent(agent.id, { card: agent.card, execution: { ...agent.execution, search: { provider: "tavily", baseUrl: "" } }, userProfile: agent.userProfile });
  store.updateAgentSearchSecret(agent.id, "tavily", "legacy-key");
  store.sqlite.exec("DELETE FROM global_search_engines");
  migrateServiceSettings(store.sqlite);
  const services = new ServiceSettings(store);
  expect(services.engines().find((item) => item.provider === "tavily")).toMatchObject({ available: true, apiKey: "legacy-key" });
  const before = services.get(); migrateServiceSettings(store.sqlite); expect(services.get()).toEqual(before);
  expect(() => services.update({ searchEngines: [before.searchEngines[0]!, before.searchEngines[0]!] })).toThrow("不能重复");
  expect(services.get()).toEqual(before);
});

it("keeps a selected URL when only the other provider has a stored secret", () => {
  const store = createStore(); const agent = store.getAgent(store.getSettings().defaultAgentId)!;
  store.updateAgent(agent.id, { card: agent.card, execution: { ...agent.execution, search: { provider: "searxng", baseUrl: "https://search.test" } }, userProfile: agent.userProfile });
  store.updateAgentSearchSecret(agent.id, "tavily", "unused-secret");
  store.sqlite.exec("DELETE FROM global_search_engines");
  migrateServiceSettings(store.sqlite);
  const engines = new ServiceSettings(store).engines();
  expect(engines.find((item) => item.provider === "searxng")).toMatchObject({ available: true, baseUrl: "https://search.test" });
  expect(engines.find((item) => item.provider === "tavily")).toMatchObject({ enabled: false, apiKey: "unused-secret" });
});
