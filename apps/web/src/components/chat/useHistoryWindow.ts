import { startTransition, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { scheduleBackgroundTask } from "../../lib/background-task";

/** Render the visible tail first; yield between small batches of older history. */
export function useHistoryWindow(total: number, scroller: RefObject<HTMLDivElement | null>, detached: boolean) {
  const [count, setCount] = useState(20);
  const anchor = useRef<{ top: number; height: number; style: string } | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !anchor.current) return;
    element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
    element.style.overflowAnchor = anchor.current.style;
    anchor.current = null;
  }, [count, scroller]);
  useEffect(() => {
    if (count >= total) return;
    return scheduleBackgroundTask(() => {
        const element = scroller.current;
        if (detached && element) {
          anchor.current = { top: element.scrollTop, height: element.scrollHeight, style: element.style.overflowAnchor };
          element.style.overflowAnchor = "none";
        }
        startTransition(() => setCount(value => Math.min(total, value + 2)));
    });
  }, [count, total, detached, scroller]);
  return Math.max(0, total - count);
}
