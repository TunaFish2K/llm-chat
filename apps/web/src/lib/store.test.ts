import { describe, expect, it } from "vitest";
import { createStore } from "./store";

describe("createStore", () => {
  it("exposes initial state and applies object patches", () => {
    const store = createStore({ count: 0, label: "a" });
    expect(store.get().count).toBe(0);
    store.set({ count: 2 });
    expect(store.get()).toEqual({ count: 2, label: "a" });
  });

  it("applies functional patches and notifies listeners", () => {
    const store = createStore({ count: 1 });
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get().count));
    store.set((current) => ({ count: current.count + 1 }));
    store.set((current) => ({ count: current.count + 1 }));
    expect(store.get().count).toBe(3);
    expect(seen).toEqual([2, 3]);
    unsubscribe();
    store.set({ count: 9 });
    expect(seen).toEqual([2, 3]);
  });
});
