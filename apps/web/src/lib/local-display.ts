import { useLayoutEffect } from "react";
import type { AppSettings } from "@llm-chat/contracts";
import { setGenerationHapticsEnabled } from "./haptics";
import { createStore, useStore } from "./store";

export interface DisplayPreferences {
  theme: AppSettings["theme"];
  accentColor: string | null;
  amoled: boolean;
  sidebarCollapsed: boolean;
  reasoningCollapsePolicy: AppSettings["uiPreferences"]["reasoningCollapsePolicy"];
  generationHaptics: boolean;
}

export const DISPLAY_KEY = "llm-chat.display.v1";
export const DISPLAY_DEFAULTS: DisplayPreferences = {
  theme: "system", accentColor: null, amoled: false, sidebarCollapsed: false,
  reasoningCollapsePolicy: "collapse-on-answer", generationHaptics: true
};
export const displayStore = createStore({ values: { ...DISPLAY_DEFAULTS }, initialized: false, saved: true });

function normalize(value: unknown): DisplayPreferences {
  const result = { ...DISPLAY_DEFAULTS };
  if (!value || typeof value !== "object") return result;
  const input = value as Record<string, unknown>;
  if (input.theme === "system" || input.theme === "light" || input.theme === "dark") result.theme = input.theme;
  if (typeof input.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(input.accentColor)) result.accentColor = input.accentColor;
  for (const key of ["amoled", "sidebarCollapsed", "generationHaptics"] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  if (input.reasoningCollapsePolicy === "always-collapsed" || input.reasoningCollapsePolicy === "collapse-on-answer"
    || input.reasoningCollapsePolicy === "never-auto-collapse") result.reasoningCollapsePolicy = input.reasoningCollapsePolicy;
  return result;
}

function parseStored(value: string | null): DisplayPreferences {
  try { return normalize(value === null ? null : JSON.parse(value)); } catch { return { ...DISPLAY_DEFAULTS }; }
}

export function saveDisplayPreferences(patch: Partial<DisplayPreferences> = {}): void {
  const values = normalize({ ...displayStore.get().values, ...patch });
  let saved = true;
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(values)); } catch { saved = false; }
  displayStore.set({ values, initialized: true, saved });
}

/** Seed each browser once; subsequent server snapshots never change its preferences. */
export function initializeDisplayPreferences(settings?: AppSettings | null): void {
  if (displayStore.get().initialized) return;
  try {
    const stored = localStorage.getItem(DISPLAY_KEY);
    if (stored !== null) {
      displayStore.set({ values: parseStored(stored), initialized: true, saved: true });
      return;
    }
  } catch { /* Keep in-memory preferences usable when storage is unavailable. */ }
  if (settings) saveDisplayPreferences(normalize({ ...settings.uiPreferences, theme: settings.theme }));
}

export function useDisplayPreferences(settings?: AppSettings | null): DisplayPreferences {
  const values = useStore(displayStore, (state) => state.values);
  useLayoutEffect(() => initializeDisplayPreferences(settings), [settings]);
  return values;
}

displayStore.subscribe(() => setGenerationHapticsEnabled(displayStore.get().values.generationHaptics));
if (typeof window !== "undefined") {
  // Restore the saved theme before the first render, including the login screen.
  initializeDisplayPreferences();
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== DISPLAY_KEY && event.key !== null) return;
    displayStore.set({ values: parseStored(event.newValue), initialized: true, saved: true });
  });
}
