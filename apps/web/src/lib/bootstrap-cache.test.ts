import { beforeEach, expect, it, vi } from "vitest";
import { appStore, bootstrap } from "./app-state";
import { endpoints, type BootstrapDto } from "./api";
import * as history from "./offline-history";
import { makeConversation, makeSettings } from "../../test/fixtures";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const snapshot = (title: string): BootstrapDto => ({ settings: makeSettings(), conversations: [makeConversation({ title })], agents: [], connections: [], models: [] });
beforeEach(() => { appStore.set({ auth: "loading", conversations: [], messages: {}, bootError: null }); });

it("renders cache while bootstrap is pending and keeps it when the network fails", async () => {
  const pending = deferred<BootstrapDto>();
  vi.spyOn(history, "offlineRequest").mockResolvedValue(snapshot("cached"));
  vi.spyOn(endpoints, "bootstrap").mockReturnValue(pending.promise);
  const boot = bootstrap();
  await Promise.resolve(); await Promise.resolve();
  expect(appStore.get().auth).toBe("ready");
  expect(appStore.get().conversations[0]?.title).toBe("cached");
  expect(appStore.get().bootRefreshing).toBe(true);
  pending.reject(new Error("network failed")); await boot;
  expect(appStore.get().auth).toBe("ready");
  expect(appStore.get().bootError).toBe("network failed");
  expect(appStore.get().bootRefreshing).toBe(false);
});

it("does not overwrite a fast network response with a slow cache", async () => {
  const cache = deferred<BootstrapDto>();
  vi.spyOn(history, "offlineRequest").mockReturnValue(cache.promise);
  vi.spyOn(endpoints, "bootstrap").mockResolvedValue(snapshot("network"));
  await bootstrap(); cache.resolve(snapshot("old"));
  await Promise.resolve();
  expect(appStore.get().conversations[0]?.title).toBe("network");
});

it("does not delete a conversation accepted while the startup request was pending", async () => {
  const pending = deferred<BootstrapDto>();
  vi.spyOn(history, "offlineRequest").mockResolvedValue(snapshot("cached"));
  vi.spyOn(endpoints, "bootstrap").mockReturnValue(pending.promise);
  const boot = bootstrap(); await Promise.resolve();
  const accepted = makeConversation({ id: "new-conversation", title: "accepted" });
  appStore.set(state => ({ conversations: [...state.conversations, accepted] }));
  pending.resolve(snapshot("network")); await boot;
  expect(appStore.get().conversations).toContainEqual(accepted);
});

it("removes cached conversations absent from the authoritative startup response", async () => {
  const pending = deferred<BootstrapDto>();
  vi.spyOn(history, "offlineRequest").mockResolvedValue({ ...snapshot("cached"), conversations: [makeConversation({ id: "deleted-cached" })] });
  vi.spyOn(endpoints, "bootstrap").mockReturnValue(pending.promise);
  const boot = bootstrap(); await Promise.resolve();
  expect(appStore.get().conversations[0]?.id).toBe("deleted-cached");
  pending.resolve({ ...snapshot("network"), conversations: [] }); await boot;
  expect(appStore.get().conversations).toEqual([]);
});

it("retains newly accepted conversations during a list refresh", async () => {
  const { refreshConversations } = await import("./app-state");
  const pending = deferred<BootstrapDto["conversations"]>();
  history.offlineStore.set({ offline: false });
  vi.spyOn(endpoints, "conversations").mockReturnValue(pending.promise);
  const refresh = refreshConversations();
  const accepted = makeConversation({ id: "accepted-during-list-refresh" });
  appStore.set({ conversations: [accepted] });
  pending.resolve([]); await refresh;
  expect(appStore.get().conversations).toEqual([accepted]);
});
