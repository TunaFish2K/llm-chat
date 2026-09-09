import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface StickToBottom {
  ref: RefObject<HTMLDivElement | null>;
  /** True while the reader has scrolled away from the newest message. */
  detached: boolean;
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
export function useStickToBottom(deps: readonly unknown[], enabled: boolean): StickToBottom {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousScrollTop = useRef<number | null>(null);
  const [detached, setDetached] = useState(false);

  const reset = useCallback(() => {
    following.current = true;
    previousScrollTop.current = null;
    setDetached(false);
  }, []);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const previous = previousScrollTop.current;
    const movedUp = previous !== null && element.scrollTop < previous;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    const nextFollowing = !movedUp && atBottom;
    previousScrollTop.current = element.scrollTop;
    following.current = nextFollowing;
    setDetached(!nextFollowing);
  }, []);

  const toBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = ref.current;
    following.current = true;
    setDetached(false);
    if (!element) return;
    if (behavior === "smooth" && typeof element.scrollTo === "function") {
      previousScrollTop.current = element.scrollTop;
      element.scrollTo({ top: element.scrollHeight, behavior });
    } else {
      element.scrollTop = element.scrollHeight;
      previousScrollTop.current = element.scrollTop;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (element && following.current) {
      element.scrollTop = element.scrollHeight;
      previousScrollTop.current = element.scrollTop;
      setDetached(false);
    }
    // The caller decides what "new content" means; usually the message array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
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

  return { ref, detached, onScroll, toBottom, reset };
}
