import { useLayoutEffect, useMemo, useRef } from "react";

/** The first loaded snapshot is history. Only a later tail append may enter. */
export function useMessageEntrance(conversationId: string | null, messages: readonly { id: string; ordinal: number }[] | null, following: boolean) {
  const baseline = useRef<{ id: string | null; loaded: boolean; ids: Set<string>; lastOrdinal: number }>({ id: null, loaded: false, ids: new Set(), lastOrdinal: -1 });
  const entered = useMemo(() => {
    const previous = baseline.current;
    if (previous.id !== conversationId || !previous.loaded || !messages || !following) return new Set<string>();
    return new Set(messages.filter(message => !previous.ids.has(message.id) && message.ordinal > previous.lastOrdinal).map(message => message.id));
  }, [conversationId, messages, following]);
  useLayoutEffect(() => {
    baseline.current = { id: conversationId, loaded: messages !== null, ids: new Set(messages?.map(message => message.id)),
      lastOrdinal: messages?.reduce((max, message) => Math.max(max, message.ordinal), -1) ?? -1 };
  }, [conversationId, messages]);
  return entered;
}
