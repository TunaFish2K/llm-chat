import { expect, it, vi } from "vitest";
import { endpoints } from "./api";
import { acceptSettings, appStore, bootstrap, refreshSettings } from "./app-state";
import { displayStore, saveDisplayPreferences } from "./local-display";
import { generationHapticsEnabled } from "./haptics";
import { makeSettings } from "../../test/fixtures";

it("seeds from bootstrap once and preserves local preferences through subsequent bootstraps and refreshes", async () => {
  history.replaceState(null, "", "/");
  appStore.set({ conversations: [] });
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vi.fn() });
  const original = makeSettings();
  const remote = makeSettings({ theme: "system", userProfile: { displayName: "Updated", description: "" } });
  const boot = vi.spyOn(endpoints, "bootstrap").mockResolvedValue({
    settings: original, agents: [], connections: [], models: [], conversations: []
  });
  const write = vi.spyOn(endpoints, "updateSettings");
  await bootstrap();
  expect(displayStore.get().values.theme).toBe("dark");
  saveDisplayPreferences({ theme: "light", accentColor: "#112233", generationHaptics: false });
  boot.mockResolvedValue({ settings: remote, agents: [], connections: [], models: [], conversations: [] });
  await bootstrap(undefined, true);
  vi.spyOn(endpoints, "settings").mockResolvedValue(remote);
  await refreshSettings();
  acceptSettings(original);
  expect(displayStore.get().values).toMatchObject({ theme: "light", accentColor: "#112233", generationHaptics: false });
  expect(generationHapticsEnabled()).toBe(false);
  expect(write).not.toHaveBeenCalled();
  acceptSettings(remote);
  expect(appStore.get().settings?.userProfile.displayName).toBe("Updated");
});

it("does not let a delayed server response overwrite a more recent local edit", async () => {
  acceptSettings(makeSettings());
  let resolve!: (settings: ReturnType<typeof makeSettings>) => void;
  vi.spyOn(endpoints, "settings").mockImplementation(() => new Promise((done) => { resolve = done; }));
  const refreshing = refreshSettings();
  saveDisplayPreferences({ theme: "light", amoled: true });
  resolve(makeSettings());
  await refreshing;
  expect(displayStore.get().values).toMatchObject({ theme: "light", amoled: true });
});
