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

  return { ref, detached, onScroll, toBottom, reset };
}
