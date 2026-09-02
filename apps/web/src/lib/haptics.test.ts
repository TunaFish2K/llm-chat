import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelGenerationHaptic,
  generationHapticsEnabled,
  generationHapticsSupported,
  scheduleGenerationHaptic,
  setGenerationHapticsEnabled
} from "./haptics";

describe("generation haptics", () => {
  const vibrate = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  afterEach(() => {
    cancelGenerationHaptic();
    vi.useRealTimers();
    vibrate.mockReset();
  });

  it("defaults to enabled on supported devices and persists the device preference", () => {
    expect(generationHapticsSupported()).toBe(true);
    expect(generationHapticsEnabled()).toBe(true);
    setGenerationHapticsEnabled(false);
    expect(generationHapticsEnabled()).toBe(false);
    expect(window.localStorage.getItem("llm-chat.generation-haptics")).toBe("off");
  });

  it("debounces streaming updates into a short pulse", () => {
    scheduleGenerationHaptic();
    vi.advanceTimersByTime(30);
    scheduleGenerationHaptic();
    vi.advanceTimersByTime(49);
    expect(vibrate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(vibrate).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith(8);
  });

  it("does not pulse while disabled or hidden", () => {
    setGenerationHapticsEnabled(false);
    scheduleGenerationHaptic();
    vi.runAllTimers();
    expect(vibrate).not.toHaveBeenCalled();

    setGenerationHapticsEnabled(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    scheduleGenerationHaptic();
    vi.runAllTimers();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
