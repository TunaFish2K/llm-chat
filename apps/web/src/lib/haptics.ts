const STORAGE_KEY = "llm-chat.generation-haptics";
const HAPTIC_DELAY_MS = 50;
const HAPTIC_DURATION_MS = 8;

let pendingPulse: ReturnType<typeof setTimeout> | null = null;

export function generationHapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function generationHapticsEnabled(): boolean {
  if (!generationHapticsSupported()) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setGenerationHapticsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* Device-local preference is best effort. */
  }
  if (!enabled) cancelGenerationHaptic();
}

export function scheduleGenerationHaptic(): void {
  if (!generationHapticsEnabled()) return;
  cancelGenerationHaptic();
  pendingPulse = setTimeout(() => {
    pendingPulse = null;
    if (!generationHapticsEnabled() || document.visibilityState !== "visible") return;
    navigator.vibrate(HAPTIC_DURATION_MS);
  }, HAPTIC_DELAY_MS);
}

export function cancelGenerationHaptic(): void {
  if (!pendingPulse) return;
  clearTimeout(pendingPulse);
  pendingPulse = null;
}
