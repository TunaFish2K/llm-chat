import { renderHook, act } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ANIMATION_DEFAULTS, ANIMATION_KEY, animationMilliseconds, animationStore, initializeAnimationPreferences, saveAnimationPreferences, useAnimationDuration } from "./animation-preferences";

beforeEach(() => animationStore.set({ values: { ...ANIMATION_DEFAULTS }, initialized: false, saved: true }));

it("restores local speeds before rendering and keeps categories independent", () => {
  localStorage.setItem(ANIMATION_KEY, JSON.stringify({ sidebar: .25, modal: 2, loading: 0 }));
  initializeAnimationPreferences();
  expect(animationMilliseconds("sidebar", "exit")).toBe(560);
  expect(animationMilliseconds("modal")).toBe(90);
  expect(animationMilliseconds("modal", "exit")).toBe(70);
  expect(animationMilliseconds("loading")).toBe(0);
  expect(document.documentElement.style.getPropertyValue("--motion-sidebar-exit")).toBe("560ms");
  expect(document.documentElement).toHaveAttribute("data-loading-motion-disabled");
  const hook = renderHook(() => useAnimationDuration("sidebar"));
  act(() => saveAnimationPreferences({ sidebar: 3 }));
  expect(hook.result.current).toBeCloseTo(140 / 3);
  expect(animationStore.get().values.modal).toBe(2);
  initializeAnimationPreferences();
  expect(animationStore.get().values.sidebar).toBe(3);
});

it.each(["bad JSON", "null", "[]", JSON.stringify({ sidebar: -1, modal: 4, page: "2", feedback: .1, loading: null })])(
  "defaults malformed local speeds: %s", stored => {
    localStorage.setItem(ANIMATION_KEY, stored);
    initializeAnimationPreferences();
    expect(animationStore.get().values).toEqual(ANIMATION_DEFAULTS);
  }
);

it("keeps edits usable when storage is blocked and retries saving without resetting them", () => {
  const read = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  initializeAnimationPreferences();
  saveAnimationPreferences({ sidebar: 0, modal: 1.4 });
  expect(animationStore.get()).toMatchObject({ values: { sidebar: 0, modal: 1.5 }, saved: false });
  expect(animationMilliseconds("sidebar")).toBe(0);
  read.mockRestore(); write.mockRestore();
  saveAnimationPreferences();
  expect(JSON.parse(localStorage.getItem(ANIMATION_KEY)!)).toMatchObject({ sidebar: 0, modal: 1.5 });
  expect(animationStore.get().saved).toBe(true);
});

it("syncs same-browser changes without echoing writes and restores defaults on removal", () => {
  const write = vi.spyOn(localStorage, "setItem");
  window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "{}" }));
  window.dispatchEvent(new StorageEvent("storage", { key: ANIMATION_KEY, newValue: JSON.stringify({ message: 2, sidebar: 0, loading: 3 }) }));
  expect(animationStore.get().values).toMatchObject({ message: 2, sidebar: 0 });
  expect(document.documentElement.style.getPropertyValue("--motion-icon-spin")).toBe("300ms");
  expect(document.documentElement).not.toHaveAttribute("data-loading-motion-disabled");
  expect(write).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent("storage", { key: ANIMATION_KEY, newValue: null }));
  expect(animationStore.get().values).toEqual(ANIMATION_DEFAULTS);
  saveAnimationPreferences({ feedback: 0 });
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
  expect(animationStore.get().values).toEqual(ANIMATION_DEFAULTS);
});
