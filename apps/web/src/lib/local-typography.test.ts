import { expect, it, vi } from "vitest";
import { makeSettings } from "../../test/fixtures";
import { initializeTypography, saveTypography, typographyStore, TYPOGRAPHY_KEY } from "./local-typography";
import { updateUiPreferences, flushUiPreferences, appStore } from "./app-state";
import { endpoints } from "./api";

it("seeds once, ignores remote changes and restores browser preferences", () => {
  const settings = makeSettings();
  initializeTypography({ ...settings.uiPreferences, chatFontSize: 18 });
  initializeTypography({ ...settings.uiPreferences, chatFontSize: 24 });
  expect(typographyStore.get().values.chatFontSize).toBe(18);
  saveTypography({ chatFontSize: 20 });
  typographyStore.set({ initialized: false });
  initializeTypography(settings.uiPreferences);
  expect(typographyStore.get().values.chatFontSize).toBe(20);
});

it("keeps the live preview after storage failure and allows retry", () => {
  const spy = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });
  saveTypography({ chatLineHeight: 2 });
  expect(typographyStore.get()).toMatchObject({ values: { chatLineHeight: 2 }, saved: false });
  saveTypography();
  expect(typographyStore.get().saved).toBe(true);
  expect(JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY)!)).toMatchObject({ chatLineHeight: 2 });
  spy.mockRestore();
});

it("validates stored values and follows same-browser storage events", () => {
  localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ chatFontSize: 99, chatLineHeight: 1.8, chatLetterSpacing: "wide" }));
  initializeTypography();
  expect(typographyStore.get().values).toEqual({ chatFontSize: 13.5, chatLineHeight: 1.8, chatLetterSpacing: 0 });
  window.dispatchEvent(new StorageEvent("storage", { key: TYPOGRAPHY_KEY, newValue: JSON.stringify({ chatFontSize: 16, chatLetterSpacing: .03, chatLineHeight: 1.6 }) }));
  expect(typographyStore.get().values.chatFontSize).toBe(16);
});

it("never sends typography fields through the shared settings writer", async () => {
  appStore.set({ settings: makeSettings() });
  const save = vi.spyOn(endpoints, "updateSettings");
  updateUiPreferences({ chatFontSize: 22, chatLetterSpacing: .02 });
  await flushUiPreferences();
  expect(save).not.toHaveBeenCalled();
  expect(typographyStore.get().values.chatFontSize).toBe(22);
});
