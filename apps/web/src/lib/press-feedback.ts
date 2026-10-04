const CONTROL = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
import { noteInteraction } from "./background-task";
import { animationMilliseconds } from "./animation-preferences";

interface Ripple { wave: HTMLElement; startedAt: number }

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Ripples render in a fixed overlay matched to the control's box, so pressing never edits
 * React-owned DOM or changes a control's positioning or clipping.
 */
function spawnRipple(element: HTMLElement, x: number, y: number): Ripple | null {
  const enter = animationMilliseconds("feedback");
  if (!enter) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const style = getComputedStyle(element);
  const radius = Math.hypot(Math.max(x - rect.left, rect.right - x), Math.max(y - rect.top, rect.bottom - y));
  const layer = document.createElement("div");
  layer.className = "press-ripple-layer";
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    // Square controls (tabs, links inside rows) still get softened corners instead of a hard slab.
    borderRadius: parseFloat(style.borderRadius) > 0 ? style.borderRadius : "var(--radius-sm, 8px)"
  });
  const wave = document.createElement("span");
  wave.className = "press-ripple";
  Object.assign(wave.style, {
    left: `${x - rect.left - radius}px`, top: `${y - rect.top - radius}px`,
    width: `${radius * 2}px`, height: `${radius * 2}px`,
    backgroundColor: `color-mix(in srgb, ${style.color || "currentColor"} 12%, transparent)`
  });
  wave.style.setProperty("--ripple-in", `${enter}ms`);
  wave.style.setProperty("--ripple-out", `${animationMilliseconds("feedback", "exit")}ms`);
  layer.append(wave);
  document.body.append(layer);
  return { wave, startedAt: performance.now() };
}

export function installPressFeedback(): () => void {
  let pressed: HTMLElement | null = null;
  let pointer: { id: number; x: number; y: number } | null = null;
  let ripple: Ripple | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releasing: HTMLElement | null = null;
  const fading = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const fadeRipple = (current: Ripple | null, immediate: boolean) => {
    if (!current) return;
    const exit = animationMilliseconds("feedback", "exit");
    if (reducedMotion() || !exit) { current.wave.parentElement?.remove(); return; }
    // Quick taps still show the wave spreading before it fades.
    const hold = immediate ? 0 : Math.max(0, animationMilliseconds("feedback") * 0.45 - (performance.now() - current.startedAt));
    current.wave.style.transitionDelay = `${hold}ms`;
    current.wave.dataset.releasing = "";
    const layer = current.wave.parentElement!;
    fading.set(layer, setTimeout(() => { layer.remove(); fading.delete(layer); }, hold + exit));
  };
  const release = (immediate = false) => {
    const element = pressed;
    fadeRipple(ripple, immediate);
    pressed = null; pointer = null; ripple = null;
    if (!element) return;
    element.dataset.pressed = "releasing";
    const duration = reducedMotion() ? 0 : animationMilliseconds("feedback", "exit");
    if (immediate || !duration) delete element.dataset.pressed;
    else { releasing = element; timer = setTimeout(() => { delete element.dataset.pressed; releasing = null; }, duration); }
  };
  const down = (event: PointerEvent) => {
    noteInteraction();
    release(true); clearTimeout(timer);
    if (releasing) { delete releasing.dataset.pressed; releasing = null; }
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(CONTROL) : null;
    if (event.button !== 0 || !element || element.matches(':disabled, [aria-disabled="true"]') || element.closest('[inert]')) return;
    pressed = element; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    element.dataset.pressed = "true";
    ripple = spawnRipple(element, event.clientX, event.clientY);
  };
  const move = (event: PointerEvent) => {
    if (pressed) noteInteraction();
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) release(true);
  };
  const up = () => release();
  const cancel = () => release(true);
  document.addEventListener("pointerdown", down, { passive: true });
  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerup", up, { passive: true });
  document.addEventListener("pointercancel", cancel, { passive: true });
  window.addEventListener("blur", cancel);
  document.addEventListener("keydown", noteInteraction, { passive: true });
  document.addEventListener("wheel", noteInteraction, { passive: true });
  document.addEventListener("touchmove", noteInteraction, { passive: true });
  return () => {
    cancel(); clearTimeout(timer);
    if (releasing) delete releasing.dataset.pressed;
    for (const [layer, pending] of fading) { clearTimeout(pending); layer.remove(); }
    fading.clear();
    document.removeEventListener("pointerdown", down);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("keydown", noteInteraction);
    document.removeEventListener("wheel", noteInteraction);
    document.removeEventListener("touchmove", noteInteraction);
  };
}
