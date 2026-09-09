import { useEffect, useRef, useState } from "react";
import { routes, type Route } from "./router";

export function parentRoute(route: Route): string | null {
  if (route.name === "agents" && route.agentId) return routes.agents();
  if (route.name === "chat" && route.conversationId) {
    if (route.taskId) return routes.conversationTasks(route.conversationId);
    if (route.view !== "chat") return routes.chat(route.conversationId);
  }
  return null;
}

const layers: Array<{ close: () => void; priority: number }> = [];
export function useBackLayer(open: boolean, close: () => void, priority = 20): void {
  const callback = useRef(close);
  callback.current = close;
  useEffect(() => {
    if (!open) return;
    const layer = { close: () => callback.current(), priority };
    layers.push(layer);
    return () => { const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1); };
  }, [open, priority]);
}

export function dismissBackLayer(): boolean {
  const layer = layers.reduce<(typeof layers)[number] | undefined>((top, next) =>
    !top || next.priority >= top.priority ? next : top, undefined);
  if (!layer) return false;
  layer.close();
  return true;
}

export function requestMobileBack(): void {
  window.dispatchEvent(new Event("llm-chat:back"));
}

function excludedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest("input, textarea, select, [contenteditable=true], [role=slider], [data-no-back-gesture]")) return true;
  if (window.getSelection()?.toString()) return true;
  for (let node: Element | null = target; node && node !== document.documentElement; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** Only a horizontal edge gesture is cancelled; vertical movement stays native. */
export function useMobileBackGesture(enabled: boolean, back: () => void): number {
  const callback = useRef(back);
  callback.current = back;
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!enabled) { setOffset(0); return; }
    let start: { x: number; y: number; id: number; locked: boolean } | null = null;
    let distance = 0;
    let suppressClickUntil = 0;
    const cancel = () => { start = null; distance = 0; setOffset(0); };
    const down = (event: TouchEvent) => {
      suppressClickUntil = 0;
      cancel();
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX > 24 || excludedTarget(event.target)) return;
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, locked: false };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.identifier !== start.id) { cancel(); return; }
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (!start.locked) {
        if (dy > 10 && dy >= Math.abs(dx)) { cancel(); return; }
        if (dx < -10) { cancel(); return; }
        if (dx < 10 || dx < dy * 1.5) return;
        start.locked = true;
      }
      if (!event.cancelable) { cancel(); return; }
      event.preventDefault();
      distance = Math.max(0, dx);
      setOffset(Math.min(distance, 96));
    };
    const up = () => {
      const commit = start?.locked && distance >= 64;
      suppressClickUntil = start?.locked ? performance.now() + 500 : 0;
      cancel();
      if (commit) callback.current();
    };
    const click = (event: MouseEvent) => {
      if (performance.now() > suppressClickUntil || !suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("touchstart", down, { passive: true, capture: true });
    window.addEventListener("touchmove", move, { passive: false, capture: true });
    window.addEventListener("touchend", up, true);
    window.addEventListener("touchcancel", cancel, true);
    window.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("touchstart", down, true);
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", up, true);
      window.removeEventListener("touchcancel", cancel, true);
      window.removeEventListener("click", click, true);
    };
  }, [enabled]);
  return enabled ? offset : 0;
}
