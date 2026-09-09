import type { AppSettings } from "@llm-chat/contracts";
import { createStore } from "./store";

export const CHAT_TYPOGRAPHY_DEFAULTS = { chatFontSize: 13.5, chatLetterSpacing: 0, chatLineHeight: 1.55 };
export type ChatTypography = typeof CHAT_TYPOGRAPHY_DEFAULTS;
export const TYPOGRAPHY_KEY = "llm-chat.typography.v1";
export const typographyStore = createStore({ values: { ...CHAT_TYPOGRAPHY_DEFAULTS }, initialized: false, saved: true });
const limits = { chatFontSize: [12, 24], chatLetterSpacing: [0, .15], chatLineHeight: [1.2, 2.4] } as const;
function normalize(value: unknown): ChatTypography {
  const result = { ...CHAT_TYPOGRAPHY_DEFAULTS };
  if (!value || typeof value !== "object") return result;
  for (const key of Object.keys(result) as Array<keyof ChatTypography>) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= limits[key][0] && candidate <= limits[key][1]) result[key] = candidate;
  }
  return result;
}
export function saveTypography(patch: Partial<ChatTypography> = {}): void {
  const values = normalize({ ...typographyStore.get().values, ...patch });
  let saved = true;
  try { localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(values)); } catch { saved = false; }
  typographyStore.set({ values, saved, initialized: true });
}
export function initializeTypography(preferences?: AppSettings["uiPreferences"]): void {
  if (typographyStore.get().initialized) return;
  try {
    const stored = localStorage.getItem(TYPOGRAPHY_KEY);
    if (stored !== null) { typographyStore.set({ values: normalize(JSON.parse(stored)), initialized: true, saved: true }); return; }
  } catch { /* Recover from malformed or unavailable local storage. */ }
  if (preferences) saveTypography(normalize(preferences));
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== TYPOGRAPHY_KEY && event.key !== null) return;
  try { typographyStore.set({ values: normalize(event.newValue ? JSON.parse(event.newValue) : null), initialized: true, saved: true }); } catch {}
});
