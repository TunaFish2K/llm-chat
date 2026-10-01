import { useLayoutEffect } from "react";
import { createStore, useStore } from "./store";

export const ANIMATION_TIMINGS = {
  sidebar: [140, 140], inspector: [200, 140], page: [180, 180], modal: [180, 140],
  popover: [180, 140], disclosure: [180, 180], message: [120, 120],
  feedback: [120, 120], toast: [140, 140], loading: [700, 700]
} as const;
export type AnimationCategory = keyof typeof ANIMATION_TIMINGS;
export type AnimationSpeeds = Record<AnimationCategory, number>;
export const ANIMATION_CATEGORIES = Object.keys(ANIMATION_TIMINGS) as AnimationCategory[];
export const ANIMATION_DEFAULTS = Object.fromEntries(ANIMATION_CATEGORIES.map(key => [key, 1])) as AnimationSpeeds;
export const ANIMATION_KEY = "llm-chat.animations.v1";
export const animationStore = createStore({ values: { ...ANIMATION_DEFAULTS }, initialized: false, saved: true });

function normalize(value: unknown): AnimationSpeeds {
  const result = { ...ANIMATION_DEFAULTS };
  if (!value || typeof value !== "object") return result;
  for (const key of ANIMATION_CATEGORIES) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && (candidate === 0 || (candidate >= .25 && candidate <= 3))) {
      result[key] = Math.round(candidate * 4) / 4;
    }
  }
  return result;
}
function parse(value: string | null): AnimationSpeeds {
  try { return normalize(value === null ? null : JSON.parse(value)); } catch { return { ...ANIMATION_DEFAULTS }; }
}
export function initializeAnimationPreferences(): void {
  if (animationStore.get().initialized) return;
  let values = { ...ANIMATION_DEFAULTS };
  try { values = parse(localStorage.getItem(ANIMATION_KEY)); } catch { /* Keep defaults usable without storage. */ }
  animationStore.set({ values, initialized: true, saved: true });
}
export function saveAnimationPreferences(patch: Partial<AnimationSpeeds> = {}): void {
  const values = normalize({ ...animationStore.get().values, ...patch });
  let saved = true;
  try { localStorage.setItem(ANIMATION_KEY, JSON.stringify(values)); } catch { saved = false; }
  animationStore.set({ values, initialized: true, saved });
}
export function animationMilliseconds(category: AnimationCategory, phase: "enter" | "exit" = "enter", speed = animationStore.get().values[category]): number {
  return speed === 0 ? 0 : ANIMATION_TIMINGS[category][phase === "enter" ? 0 : 1] / speed;
}
export function useAnimationDuration(category: AnimationCategory, phase: "enter" | "exit" = "enter"): number {
  const speed = useStore(animationStore, state => state.values[category]);
  useLayoutEffect(initializeAnimationPreferences, []);
  return animationMilliseconds(category, phase, speed);
}

function apply(): void {
  const root = document.documentElement;
  const set = (name: string, value: number) => {
    const duration = `${value}ms`;
    if (root.style.getPropertyValue(name) !== duration) root.style.setProperty(name, duration);
  };
  for (const category of ANIMATION_CATEGORIES) {
    set(`--motion-${category}-enter`, animationMilliseconds(category));
    set(`--motion-${category}-exit`, animationMilliseconds(category, "exit"));
  }
  const { page, loading } = animationStore.get().values;
  set("--dur-fast", animationMilliseconds("feedback"));
  set("--dur-med", page === 0 ? 0 : 220 / page);
  set("--motion-icon-spin", loading === 0 ? 0 : 900 / loading);
  set("--motion-pulse", loading === 0 ? 0 : 1_400 / loading);
  root.toggleAttribute("data-loading-motion-disabled", loading === 0);
}
if (typeof window !== "undefined") {
  animationStore.subscribe(apply);
  initializeAnimationPreferences();
  window.addEventListener("storage", event => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== ANIMATION_KEY && event.key !== null) return;
    animationStore.set({ values: parse(event.newValue), initialized: true, saved: true });
  });
}
