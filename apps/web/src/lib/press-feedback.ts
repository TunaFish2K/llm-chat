const CONTROL = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
import { noteInteraction } from "./background-task";
import { animationMilliseconds } from "./animation-preferences";

export function installPressFeedback(): () => void {
  let pressed: HTMLElement | null = null;
  let pointer: { id: number; x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releasing: HTMLElement | null = null;
  const release = (immediate = false) => {
    const element = pressed;
    pressed = null; pointer = null;
    if (!element) return;
    element.dataset.pressed = "releasing";
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : animationMilliseconds("feedback");
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
