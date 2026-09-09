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
    .mockImplementation(async (patch) => ({ ...original, uiPreferences: { ...original.uiPreferences, accentColor: "#112233", ...Object.fromEntries(Object.entries(patch.uiPreferences ?? {}).filter(([, value]) => value !== undefined)) } }));
  updateUiPreferences({ accentColor: "#445566" });
  expect(appStore.get().settings?.uiPreferences.accentColor).toBe("#445566");
  expect(save).not.toHaveBeenCalled();
  const saving = flushUiPreferences();
  updateUiPreferences({ accentColor: "#112233", amoled: true });
  acceptSettings({ ...original, uiPreferences: { ...original.uiPreferences, accentColor: "#778899" } });
  expect(appStore.get().settings?.uiPreferences).toMatchObject({ accentColor: "#112233", amoled: true });
  resolve({ ...original, uiPreferences: { ...original.uiPreferences, accentColor: "#445566" } });
  await saving;
  expect(save).toHaveBeenLastCalledWith({ uiPreferences: { accentColor: "#112233", amoled: true } });
  expect(appStore.get().settings?.uiPreferences.accentColor).toBe("#112233");
  expect(preferenceSaveStore.get().status).toBe("saved");
});

it("retains failed edits for retry and does not discard them on remote updates", async () => {
  const original = makeSettings();
  appStore.set({ settings: original });
  const save = vi.spyOn(endpoints, "updateSettings").mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (patch) => ({ ...original, uiPreferences: { ...original.uiPreferences, ...Object.fromEntries(Object.entries(patch.uiPreferences ?? {}).filter(([, value]) => value !== undefined)) } }));
  updateUiPreferences({ generationHaptics: false });
  await flushUiPreferences();
  expect(preferenceSaveStore.get().status).toBe("error");
  acceptSettings(original);
  expect(appStore.get().settings?.uiPreferences.generationHaptics).toBe(false);
  await flushUiPreferences();
  expect(save).toHaveBeenCalledTimes(2);
  expect(preferenceSaveStore.get().status).toBe("saved");
  expect(appStore.get().settings?.uiPreferences.generationHaptics).toBe(false);
});
