import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationDto } from "@llm-chat/contracts";

export const ConversationList = memo(function ConversationList({ groups, activeId, renderRow }: {
  groups: Array<{ label: string; items: ConversationDto[] }>;
  activeId: string | null;
  renderRow: (conversation: ConversationDto) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => groups.flatMap(group => [
    { key: `group:${group.label}`, label: group.label, conversation: null },
    ...group.items.map(conversation => ({ key: conversation.id, label: group.label, conversation }))
  ]), [groups]);
  const virtual = rows.length > 40;
  const activeIndex = rows.findIndex(row => row.conversation?.id === activeId);
  const list = useVirtualizer({
    count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: index => rows[index]?.conversation ? 72 : 28,
    getItemKey: index => rows[index]!.key, overscan: 5, enabled: virtual,
    initialRect: { width: 320, height: 600 }, useFlushSync: false,
    useAnimationFrameWithResizeObserver: true
  });
  useEffect(() => {
    const reveal = () => {
      if (virtual && activeIndex >= 0) list.scrollToIndex(activeIndex, { align: "auto" });
      else scroll.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
    };
    reveal();
    window.addEventListener("llm-chat:reveal-conversation", reveal);
    return () => window.removeEventListener("llm-chat:reveal-conversation", reveal);
  }, [activeIndex, virtual, list]);
  return <div ref={scroll} className="conversation-scroll" data-virtual={virtual || undefined}>
    {virtual ? <div role="list" className="conversation-virtual" style={{ height: list.getTotalSize() }}>
      {list.getVirtualItems().map(item => {
        const row = rows[item.index]!;
        return <div key={item.key} data-index={item.index}
          className={row.conversation ? "conversation-virtual-row" : "conversation-group"}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
          {row.conversation ? renderRow(row.conversation) : <h2>{row.label}</h2>}
        </div>;
      })}
    </div> : groups.map(group => <section className="conversation-group" key={group.label}>
      <h2>{group.label}</h2><div role="list" aria-label={group.label}>{group.items.map(renderRow)}</div>
    </section>)}
  </div>;
});
