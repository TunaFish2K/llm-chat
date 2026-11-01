import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(cleanupStores);

it("starts every new discovery disabled, preserving explicit enablement on rediscovery", () => {
  const store = createStore();
  const { model } = seedModel(store);
  const input = { ...model, modelKey: "discovered", enabled: true };
  const discovered = store.upsertDiscoveredModel(input, null).model;
  expect(discovered).toMatchObject({ enabled: false, catalogManaged: true });
  store.setModelsEnabled([discovered.id], true);
  expect(store.upsertDiscoveredModel(input, null).model.enabled).toBe(true);
  store.setModelsEnabled([discovered.id], false);
  expect(store.upsertDiscoveredModel(input, null).model.enabled).toBe(false);
  expect(store.getModel(model.id)?.enabled).toBe(true);
});

it("validates the entire batch, deduplicates IDs and preserves catalog management", () => {
  const store = createStore();
  const { model } = seedModel(store);
  const other = store.upsertDiscoveredModel({ ...model, modelKey: "other" }, null).model;
  expect(() => store.setModelsEnabled([model.id, randomUUID()], false)).toThrow();
  expect(store.getModel(model.id)?.enabled).toBe(true);
  expect(store.setModelsEnabled([model.id, other.id, other.id], false)).toHaveLength(2);
  expect(store.getModel(other.id)?.catalogManaged).toBe(true);
  expect(store.setModelsEnabled([model.id, other.id], true).every(model => model.enabled)).toBe(true);
});
