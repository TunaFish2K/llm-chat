import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { MessageDto } from "@llm-chat/contracts";
import { useHistoryRendering } from "../../lib/history-rendering";
import { LoadingState } from "../ui";

export function VirtualMessageList({ messages, scroller, following, renderMessage }: {
  messages: readonly MessageDto[];
  scroller: RefObject<HTMLDivElement | null>;
  following: boolean;
  renderMessage: (message: MessageDto) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const allowed = useHistoryRendering();
  const [primed, setPrimed] = useState(false);
  const estimate = useCallback((index: number) => messages[index]?.role === "user" ? 120 : 280, [messages]);
  const itemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const initialOffset = useMemo(() => Math.max(0, messages.reduce((total, message) => total + (message.role === "user" ? 120 : 280), 0) - 600), []);
  const list = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    getItemKey: itemKey,
    estimateSize: estimate,
    initialRect: { width: 360, height: 600 },
    initialOffset,
    scrollMargin: margin,
    overscan: 1,
    rangeExtractor: primed ? defaultRangeExtractor : () => [],
    enabled: primed,
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true
  });
  list.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => following || item.start < (instance.scrollOffset ?? 0);
  useEffect(() => {
    if (primed || !allowed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Let the title and editable composer paint before mounting rich history.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { timer = setTimeout(() => startTransition(() => setPrimed(true)), 0); });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [primed, allowed]);
  useLayoutEffect(() => {
    const node = container.current, scroll = scroller.current;
    if (!primed || !node || !scroll) return;
    const measure = () => setMargin(node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [primed, scroller]);
  return <div ref={container} className="message-virtual-list" data-message-count={messages.length} style={{ height: primed ? list.getTotalSize() : initialOffset + 600 }}>
    {!primed ? <div className="message-history-loading"><LoadingState /></div> : null}
    {list.getVirtualItems().map(item => <div
      key={item.key}
      ref={list.measureElement}
      data-index={item.index}
      className="message-virtual-row"
      style={{ transform: `translateY(${item.start - margin}px)` }}
    >{renderMessage(messages[item.index]!)}</div>)}
  </div>;
}
