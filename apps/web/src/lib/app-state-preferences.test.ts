import { afterEach, expect, it, vi } from "vitest";
import { endpoints } from "./api";
import { acceptSettings, appStore, flushUiPreferences, preferenceSaveStore, updateUiPreferences } from "./app-state";
import { makeSettings } from "../../test/fixtures";

afterEach(() => vi.restoreAllMocks());

it("previews immediately and merges new edits over delayed saves and remote refreshes", async () => {
  const original = makeSettings();
  appStore.set({ settings: original });
  let resolve!: (value: typeof original) => void;
  const save = vi.spyOn(endpoints, "updateSettings")
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockImplementation(async (patch) => ({ ...original, uiPreferences: { ...original.uiPreferences, chatFontSize: 20, ...Object.fromEntries(Object.entries(patch.uiPreferences ?? {}).filter(([, value]) => value !== undefined)) } }));
  updateUiPreferences({ chatFontSize: 18 });
  expect(appStore.get().settings?.uiPreferences.chatFontSize).toBe(18);
  expect(save).not.toHaveBeenCalled();
  const saving = flushUiPreferences();
  updateUiPreferences({ chatFontSize: 20, chatLineHeight: 1.8 });
  acceptSettings({ ...original, uiPreferences: { ...original.uiPreferences, accentColor: "#018EEE", chatFontSize: 16 } });
  expect(appStore.get().settings?.uiPreferences).toMatchObject({ chatFontSize: 20, chatLineHeight: 1.8, accentColor: "#018EEE" });
  resolve({ ...original, uiPreferences: { ...original.uiPreferences, chatFontSize: 18 } });
  await saving;
  expect(save).toHaveBeenLastCalledWith({ uiPreferences: { chatFontSize: 20, chatLineHeight: 1.8 } });
  expect(appStore.get().settings?.uiPreferences.chatFontSize).toBe(20);
  expect(preferenceSaveStore.get().status).toBe("saved");
});

it("retains failed edits for retry and does not discard them on remote updates", async () => {
  const original = makeSettings();
  appStore.set({ settings: original });
  const save = vi.spyOn(endpoints, "updateSettings").mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (patch) => ({ ...original, uiPreferences: { ...original.uiPreferences, ...Object.fromEntries(Object.entries(patch.uiPreferences ?? {}).filter(([, value]) => value !== undefined)) } }));
  updateUiPreferences({ chatLetterSpacing: 0.1 });
  await flushUiPreferences();
  expect(preferenceSaveStore.get().status).toBe("error");
  acceptSettings(original);
  expect(appStore.get().settings?.uiPreferences.chatLetterSpacing).toBe(0.1);
  await flushUiPreferences();
  expect(save).toHaveBeenCalledTimes(2);
  expect(preferenceSaveStore.get().status).toBe("saved");
  expect(appStore.get().settings?.uiPreferences.chatLetterSpacing).toBe(0.1);
});
