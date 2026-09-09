import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface StickToBottom {
  ref: RefObject<HTMLDivElement | null>;
  /** True while the reader has scrolled away from the newest message. */
  detached: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Jump back to the newest message and re-arm auto-follow. */
  toBottom: (behavior?: ScrollBehavior) => void;
  /** Re-arm auto-follow without touching the scroll position yet. */
  reset: () => void;
}

/**
 * Keeps a scroller pinned to the newest content while the reader is at the
 * bottom, and stops fighting them the moment they scroll up — streaming tokens
 * must never yank the viewport away from something being read.
 */
export function useStickToBottom(
  deps: readonly unknown[], enabled: boolean,
  { initialFollowing = true, preservePosition = false }: { initialFollowing?: boolean; preservePosition?: boolean } = {}
): StickToBottom {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(initialFollowing);
  const dimensions = useRef({ height: 0, viewport: 0 });
  const smooth = useRef(false);
  const frame = useRef<number | null>(null);
  const previousScrollTop = useRef<number | null>(null);
  const [detached, setDetached] = useState(!initialFollowing);

  const reset = useCallback(() => {
    following.current = true;
    smooth.current = false;
    previousScrollTop.current = null;
    setDetached(false);
  }, []);

  const toBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = ref.current;
    following.current = true;
    setDetached(false);
    if (!element) return;
    smooth.current = behavior === "smooth";
    dimensions.current = { height: element.scrollHeight, viewport: element.clientHeight };
    if (behavior === "smooth" && typeof element.scrollTo === "function") {
      previousScrollTop.current = element.scrollTop;
      element.scrollTo({ top: element.scrollHeight, behavior });
    } else {
      element.scrollTop = element.scrollHeight;
      previousScrollTop.current = element.scrollTop;
    }
  }, []);

  const syncLayout = useCallback(() => {
    const element = ref.current;
    if (!enabled || !element || !element.clientHeight) return;
    const previous = dimensions.current;
    // A new chunk can arrive after the reader reaches the old bottom but before
    // the browser delivers their scroll event. Preserve that request to resume.
    const returnedToBottom = previousScrollTop.current !== null &&
      element.scrollTop > previousScrollTop.current &&
      previous.height > previous.viewport && previous.viewport === element.clientHeight &&
      element.scrollTop >= previous.height - previous.viewport - 1;
    if (following.current || returnedToBottom) toBottom();
    else dimensions.current = { height: element.scrollHeight, viewport: element.clientHeight };
  }, [enabled, toBottom]);

  const follow = useCallback(() => {
    if (!enabled || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      syncLayout();
    });
  }, [enabled, syncLayout]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!enabled || !element || !element.clientHeight) return;
    const previous = previousScrollTop.current;
    const resized = dimensions.current.height !== element.scrollHeight || dimensions.current.viewport !== element.clientHeight;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    const movedUp = previous !== null && element.scrollTop < previous;
    previousScrollTop.current = element.scrollTop;
    dimensions.current = { height: element.scrollHeight, viewport: element.clientHeight };
    if (smooth.current && !(movedUp && !resized)) {
      if (atBottom) smooth.current = false;
      return;
    }
    smooth.current = false;
    // Expanding content and browser scroll anchoring are not an instruction to stop following.
    if (following.current && resized) { follow(); return; }
    const nextFollowing = !movedUp && atBottom;
    following.current = nextFollowing;
    setDetached(!nextFollowing);
  }, [enabled, follow]);

  useLayoutEffect(() => {
    syncLayout();
    // The caller identifies content changes, including growth inside a capped scroll area.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    element.dataset.stickScroll = "";
    if (preservePosition && !following.current && previousScrollTop.current !== null) {
      element.scrollTop = previousScrollTop.current;
    }
    dimensions.current = { height: element.scrollHeight, viewport: element.clientHeight };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(element);
    if (contentRef.current) observer?.observe(contentRef.current);
    const ownsInput = (event: Event) => event.target instanceof Element && event.target.closest("[data-stick-scroll]") === element;
    const detach = () => {
      if (element.scrollHeight <= element.clientHeight) return;
      following.current = false;
      setDetached(true);
      if (smooth.current) {
        smooth.current = false;
        element.scrollTo({ top: element.scrollTop, behavior: "auto" });
      }
    };
    const wheel = (event: WheelEvent) => { if (ownsInput(event) && event.deltaY < 0) detach(); };
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = ownsInput(event) ? event.touches[0]?.clientY : undefined; };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== undefined && y !== undefined && y > touchY) detach();
      if (touchY !== undefined) touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (!ownsInput(event) || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) detach();
    };
    const scrollEnd = () => {
      if (!smooth.current) return;
      smooth.current = false;
      if (following.current) toBottom();
    };
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: true });
    element.addEventListener("keydown", key);
    element.addEventListener("scrollend", scrollEnd);
    return () => {
      observer?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      delete element.dataset.stickScroll;
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
      element.removeEventListener("keydown", key);
      element.removeEventListener("scrollend", scrollEnd);
    };
  }, [enabled, follow, preservePosition, toBottom]);

  useEffect(() => {
    if (!enabled) return;
    let anchor: Element | undefined;
    let anchorTop = 0;
    let wasFollowing = false;
    const before = () => {
      const element = ref.current;
      if (!enabled || !element) return;
      wasFollowing = following.current;
      const top = element.getBoundingClientRect().top;
      anchor = [...element.querySelectorAll(".msg-bubble, .markdown :is(p, li, h1, h2, h3, h4, pre, table), .process-reasoning > div, .reply-footer")].find((item) => item.getClientRects().length && item.getBoundingClientRect().bottom > top);
      anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    };
    const after = () => {
      const element = ref.current;
      if (!enabled || !element) return;
      if (wasFollowing) toBottom();
      else if (anchor?.isConnected) {
        element.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        previousScrollTop.current = element.scrollTop;
      }
    };
    window.addEventListener("llm-chat:before-typography", before);
    window.addEventListener("llm-chat:after-typography", after);
    return () => {
      window.removeEventListener("llm-chat:before-typography", before);
      window.removeEventListener("llm-chat:after-typography", after);
    };
  }, [enabled, toBottom]);

  return { ref, contentRef, detached, onScroll, toBottom, reset };
}
