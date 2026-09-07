const HAPTIC_DELAY_MS = 50;
const HAPTIC_DURATION_MS = 8;

let pendingPulse: ReturnType<typeof setTimeout> | null = null;
let configuredEnabled = true;

export function generationHapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function generationHapticsEnabled(): boolean {
  return configuredEnabled && generationHapticsSupported();
}

export function setGenerationHapticsEnabled(enabled: boolean): void {
  configuredEnabled = enabled;
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
