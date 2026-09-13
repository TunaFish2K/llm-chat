import { afterEach, expect, it, vi } from "vitest";
import { makeSettings } from "../../test/fixtures";
import { DISPLAY_DEFAULTS, DISPLAY_KEY, displayStore, initializeDisplayPreferences, saveDisplayPreferences } from "./local-display";
import { generationHapticsEnabled, scheduleGenerationHaptic } from "./haptics";
import { initializeTypography, saveTypography, typographyStore } from "./local-typography";

afterEach(() => vi.useRealTimers());

it("waits for a settings snapshot before seeding an empty browser, and never migrates twice", () => {
  initializeDisplayPreferences();
  expect(displayStore.get().initialized).toBe(false);
  const settings = makeSettings({ theme: "light" });
  initializeDisplayPreferences(settings);
  expect(JSON.parse(localStorage.getItem(DISPLAY_KEY)!)).toMatchObject({ theme: "light" });
  initializeDisplayPreferences(makeSettings());
  expect(displayStore.get().values.theme).toBe("light");
  saveDisplayPreferences({ theme: "dark", amoled: true });
  displayStore.set({ initialized: false });
  initializeDisplayPreferences(settings);
  expect(displayStore.get().values).toMatchObject({ theme: "dark", amoled: true });
});

it("restores local preferences before a server snapshot and preserves existing typography", () => {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify({ ...DISPLAY_DEFAULTS, theme: "light" }));
  saveTypography({ chatFontSize: 22 });
  initializeDisplayPreferences();
  const settings = makeSettings();
  initializeDisplayPreferences(settings);
  initializeTypography(settings.uiPreferences);
  expect(displayStore.get().values.theme).toBe("light");
  expect(typographyStore.get().values.chatFontSize).toBe(22);
});

it.each(["broken JSON", "null", "[]", JSON.stringify({ theme: "blue", accentColor: "red", amoled: 1, sidebarCollapsed: "true", generationHaptics: null, reasoningCollapsePolicy: "bad" })])(
  "defaults invalid stored values without importing remote preferences: %s", (stored) => {
    localStorage.setItem(DISPLAY_KEY, stored);
    initializeDisplayPreferences(makeSettings());
    expect(displayStore.get().values).toEqual(DISPLAY_DEFAULTS);
  }
);

it("validates individual fields while preserving valid partial values", () => {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify({ theme: "dark", amoled: true, accentColor: "invalid", reasoningCollapsePolicy: "always-collapsed" }));
  initializeDisplayPreferences();
  expect(displayStore.get().values).toEqual({ ...DISPLAY_DEFAULTS, theme: "dark", amoled: true, reasoningCollapsePolicy: "always-collapsed" });
});

it("keeps local edits in memory if storage is unavailable and supports retry", () => {
  const read = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  initializeDisplayPreferences(makeSettings());
  saveDisplayPreferences({ theme: "light" });
  initializeDisplayPreferences(makeSettings());
  expect(displayStore.get()).toMatchObject({ values: { theme: "light" }, initialized: true, saved: false });
  read.mockRestore(); write.mockRestore();
  saveDisplayPreferences();
  expect(displayStore.get().saved).toBe(true);
  expect(JSON.parse(localStorage.getItem(DISPLAY_KEY)!)).toMatchObject({ theme: "light" });
});

it("updates from same-browser storage events without echoing writes and resets on removal", () => {
  initializeDisplayPreferences(makeSettings());
  const write = vi.spyOn(localStorage, "setItem");
  window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "{}" }));
  expect(displayStore.get().values.theme).toBe("dark");
  window.dispatchEvent(new StorageEvent("storage", { key: DISPLAY_KEY, newValue: JSON.stringify({ theme: "light", generationHaptics: false }) }));
  expect(displayStore.get().values).toMatchObject({ theme: "light", generationHaptics: false });
  expect(write).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent("storage", { key: DISPLAY_KEY, newValue: null }));
  expect(displayStore.get().values).toEqual(DISPLAY_DEFAULTS);
  saveDisplayPreferences({ theme: "dark" });
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
  initializeDisplayPreferences(makeSettings());
  expect(displayStore.get().values).toEqual(DISPLAY_DEFAULTS);
});

it("immediately cancels a pending vibration when disabled locally or by another tab", () => {
  vi.useFakeTimers();
  const vibrate = vi.fn();
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  saveDisplayPreferences({ generationHaptics: true });
  expect(generationHapticsEnabled()).toBe(true);
  scheduleGenerationHaptic();
  saveDisplayPreferences({ generationHaptics: false });
  vi.advanceTimersByTime(100);
  expect(vibrate).not.toHaveBeenCalled();
  saveDisplayPreferences({ generationHaptics: true });
  scheduleGenerationHaptic();
  window.dispatchEvent(new StorageEvent("storage", { key: DISPLAY_KEY, newValue: JSON.stringify({ generationHaptics: false }) }));
  vi.advanceTimersByTime(100);
  expect(vibrate).not.toHaveBeenCalled();
  expect(generationHapticsEnabled()).toBe(false);
});
