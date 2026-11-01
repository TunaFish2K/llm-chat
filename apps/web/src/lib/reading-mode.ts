import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { hasBackLayerAbove, useBackLayer } from "./mobile-navigation";

/** Anchor a visible text position, rather than a scroll offset that changes on reflow. */
function captureReadingPosition(): () => void {
  const scroll = document.querySelector<HTMLElement>(".chat-scroll");
  if (!scroll) return () => {};
  const viewport = scroll.getBoundingClientRect();
  const row = [...scroll.querySelectorAll<HTMLElement>(".message-virtual-row")]
    .find(node => node.getBoundingClientRect().bottom > viewport.top + 16);
  // A bubble wraps the entire answer. Choosing it before its paragraphs would
  // preserve the answer's top instead of the text currently being read when a
  // narrow viewport reflows. Use a visible content block before the fallback.
  const block = row && ([...row.querySelectorAll<HTMLElement>("p, pre, li, h1, h2, h3, table")]
    .find(node => node.getBoundingClientRect().bottom > viewport.top + 16)
    ?? row.querySelector<HTMLElement>(".msg-bubble") ?? row);
  if (!block) return () => {};
  const offset = block.getBoundingClientRect().top - viewport.top;
  // Capture a character near the top of the viewport for long paragraphs.
  const pointDoc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const rect = block.getBoundingClientRect();
  const x = Math.max(rect.left + 8, viewport.left + 12), y = Math.max(rect.top + 8, viewport.top + 16);
  const caret = pointDoc.caretPositionFromPoint?.(x, y);
  const range = pointDoc.caretRangeFromPoint?.(x, y) ?? (caret ? document.createRange() : null);
  if (caret && range) { range.setStart(caret.offsetNode, caret.offset); range.collapse(true); }
  const textAnchor = range && block.contains(range.startContainer) && range.getBoundingClientRect().height ? range : null;
  const textOffset = textAnchor ? textAnchor.getBoundingClientRect().top - viewport.top : offset;
  return () => {
    if (!block.isConnected || !scroll.isConnected) return;
    const top = textAnchor?.startContainer.isConnected ? textAnchor.getBoundingClientRect().top : block.getBoundingClientRect().top;
    const target = scroll.scrollTop + top - scroll.getBoundingClientRect().top - (textAnchor ? textOffset : offset);
    const maximum = scroll.scrollHeight - scroll.clientHeight;
    // Near the end, hiding chrome makes the viewport taller and the transcript
    // shorter. Add just enough trailing space to keep the current text in place
    // instead of letting the browser clamp the scroll position upward.
    if (target > maximum && scroll.closest(".app-frame[data-reading]")) {
      const tail = Number.parseFloat(scroll.style.getPropertyValue("--reading-tail")) || 0;
      scroll.style.setProperty("--reading-tail", `${Math.ceil(tail + target - maximum)}px`);
    }
    scroll.scrollTop = target;
  };
}

export function excludedReadingGesture(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !target.closest(".chat-scroll")) return true;
  if (target.closest("a, button, input, textarea, select, summary, [contenteditable=true], [role=slider], img, video, audio, canvas, iframe, [data-no-back-gesture]")) return true;
  if (window.getSelection()?.toString()) return true;
  for (let node: Element | null = target; node && !node.matches(".chat-scroll"); node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** Temporary per-conversation state; no saved display preferences are changed. */
export function useReadingMode(scope: string | null) {
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const reading = scope !== null && activeScope === scope;
  const restore = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const enter = useCallback(() => {
    if (!scope) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restore.current = captureReadingPosition();
    setActiveScope(scope);
  }, [scope]);
  const exit = useCallback(() => {
    restore.current = captureReadingPosition();
    setActiveScope(null);
  }, []);
  useEffect(() => { setActiveScope(null); restore.current = null; }, [scope]);
  useBackLayer(reading, exit, 0);
  useLayoutEffect(() => {
    if (!restore.current) return;
    const anchor = restore.current;
    restore.current = null;
    const scroll = document.querySelector<HTMLElement>(".chat-scroll");
    scroll?.style.removeProperty("--reading-tail");
    const overflowAnchor = scroll?.style.overflowAnchor ?? "";
    if (scroll) scroll.style.overflowAnchor = "none";
    const release = () => { if (scroll) scroll.style.overflowAnchor = overflowAnchor; };
    const focus = reading ? document.querySelector<HTMLElement>(".chat-scroll") : trigger.current;
    focus?.focus({ preventScroll: true });
    anchor();
    let remaining = 4;
    let frame = requestAnimationFrame(function settle() {
      anchor();
      if (--remaining > 0) frame = requestAnimationFrame(settle); else release();
    });
    return () => { cancelAnimationFrame(frame); release(); };
  }, [reading]);
  useEffect(() => {
    if (!reading) return;
    const blocked = () => hasBackLayerAbove(0) || Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "q" || event.repeat || event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || blocked()) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); exit();
    };
    type TouchStart = { x: number; y: number; time: number; id: number; locked: boolean; moved: boolean };
    let start: TouchStart | null = null;
    let tap: { x: number; y: number; time: number } | null = null;
    let suppressClickUntil = 0;
    const cancel = () => { start = null; tap = null; };
    const down = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (blocked() || event.touches.length !== 1 || !touch || excludedReadingGesture(event.target)) { cancel(); return; }
      start = { x: touch.clientX, y: touch.clientY, time: performance.now(), id: touch.identifier, locked: false, moved: false };
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start) return;
      if (event.touches.length !== 1 || !touch || touch.identifier !== start.id) { cancel(); return; }
      const dx = start.x - touch.clientX, dy = Math.abs(start.y - touch.clientY);
      if (Math.abs(dx) > 10 || dy > 10) { start.moved = true; tap = null; }
      if (!start.locked) {
        if ((dy > 10 && dy >= Math.abs(dx)) || dx < -10) { cancel(); return; }
        if (dx < 10 || dx < dy * 1.5) return;
        start.locked = true;
      }
      if (event.cancelable) event.preventDefault(); else cancel();
    };
    const up = (event: TouchEvent) => {
      const touch = [...event.changedTouches].find(touch => touch.identifier === start?.id);
      if (!start || !touch || blocked() || excludedReadingGesture(event.target)) { cancel(); return; }
      const now = performance.now(), dx = start.x - touch.clientX, dy = Math.abs(start.y - touch.clientY);
      const swipe = start.locked && dx >= 64 && dx >= dy * 1.5;
      const quickTap = !start.moved && Math.hypot(dx, dy) <= 10 && now - start.time <= 250;
      const doubleTap = quickTap && tap && now - tap.time <= 300 && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) <= 24;
      if (swipe || doubleTap) {
        if (event.cancelable) event.preventDefault();
        suppressClickUntil = now + 500;
        cancel(); exit();
      } else { tap = quickTap ? { x: touch.clientX, y: touch.clientY, time: now } : null; start = null; }
    };
    const click = (event: MouseEvent) => {
      if (event.detail === 0 || performance.now() >= suppressClickUntil) return;
      event.preventDefault(); event.stopPropagation(); suppressClickUntil = 0;
    };
    const scroll = () => { tap = null; };
    window.addEventListener("keydown", key);
    window.addEventListener("touchstart", down, { passive: true, capture: true });
    window.addEventListener("touchmove", move, { passive: false, capture: true });
    window.addEventListener("touchend", up, { passive: false, capture: true });
    window.addEventListener("touchcancel", cancel, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchstart", down, true);
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", up, true);
      window.removeEventListener("touchcancel", cancel, true);
      window.removeEventListener("scroll", scroll, true);
      // Keep the click guard through the synthetic click following touchend.
      if (suppressClickUntil > performance.now()) setTimeout(() => window.removeEventListener("click", click, true), 500);
      else window.removeEventListener("click", click, true);
    };
  }, [reading, exit]);
  return { reading, enter, exit };
}
