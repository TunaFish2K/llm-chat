import { createStore, useStore } from "./store";

export const REQUEST_PREFERENCES_KEY = "llm-chat.requests.v1";
export const DEFAULT_REQUEST_RETRIES = 2;
let volatileRetries: number | undefined;
function normalize(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5 ? value : DEFAULT_REQUEST_RETRIES;
}
export function requestRetries(): number {
  if (volatileRetries !== undefined) return volatileRetries;
  try { return normalize(JSON.parse(localStorage.getItem(REQUEST_PREFERENCES_KEY) ?? "null")?.maxRetries); }
  catch { return DEFAULT_REQUEST_RETRIES; }
}
const preferences = createStore({ maxRetries: requestRetries(), saved: true });
export function saveRequestRetries(value: number): void {
  const maxRetries = normalize(value);
  let saved = true;
  try {
    localStorage.setItem(REQUEST_PREFERENCES_KEY, JSON.stringify({ maxRetries }));
    volatileRetries = undefined;
  } catch { saved = false; volatileRetries = maxRetries; }
  preferences.set({ maxRetries, saved });
}
export function useRequestPreferences() {
  return useStore(preferences, state => state);
}
window.addEventListener("storage", event => {
  if (event.key === REQUEST_PREFERENCES_KEY || event.key === null) {
    volatileRetries = undefined;
    preferences.set({ maxRetries: requestRetries(), saved: true });
  }
});
