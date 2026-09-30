import { afterEach, expect, it, vi } from "vitest";
import { makeAgent, makeConnection, makeConversation, makeModel, makeSettings } from "../../test/fixtures";
import { clearStartupCache, readStartupCache, scheduleStartupCache } from "./startup-cache";

const snapshot = () => ({ sourceId: "instance", settings: makeSettings(), agents: [makeAgent()], connections: [makeConnection()], models: [makeModel()], conversations: [makeConversation()] });
afterEach(() => { clearStartupCache(); vi.useRealTimers(); });

it("restores startup catalogs independently of the full offline-history preference", () => {
  localStorage.setItem("llm-chat.offline-enabled", "false");
  localStorage.setItem("llm-chat.startup.v1", JSON.stringify({ version: 1, data: snapshot() }));
  expect(readStartupCache()).toEqual(snapshot());
});

it.each([
  "broken json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, data: { sourceId: "" } }),
  ...["settings", "agents", "models", "connections", "conversations"].map(field => JSON.stringify({ version: 1, data: { ...snapshot(), [field]: field === "settings" ? {} : [{ id: "corrupt" }] } }))
])("ignores damaged startup data without blocking the shell: %s", value => {
  localStorage.setItem("llm-chat.startup.v1", value);
  expect(readStartupCache()).toBeUndefined();
});

it("coalesces metadata writes, reads the newest state, and cancels writes on logout", () => {
  vi.useFakeTimers();
  let data = snapshot();
  scheduleStartupCache(() => data);
  data = { ...data, conversations: [makeConversation({ title: "Latest" })] };
  scheduleStartupCache(() => data);
  vi.advanceTimersByTime(250);
  expect(readStartupCache()?.conversations[0]?.title).toBe("Latest");
  expect(localStorage.getItem("llm-chat.startup.v1")).not.toContain('"messages"');
  scheduleStartupCache(() => data);
  clearStartupCache();
  vi.advanceTimersByTime(250);
  expect(readStartupCache()).toBeUndefined();
  scheduleStartupCache(() => undefined);
  vi.advanceTimersByTime(250);
  expect(readStartupCache()).toBeUndefined();
});

it("tolerates unavailable browser storage", () => {
  vi.useFakeTimers();
  vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Full"); });
  vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("Unavailable"); });
  expect(readStartupCache()).toBeUndefined();
  scheduleStartupCache(snapshot);
  expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  expect(clearStartupCache).not.toThrow();
});
