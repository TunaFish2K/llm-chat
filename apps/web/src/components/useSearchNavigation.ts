import { useEffect, useId, useState, type KeyboardEvent } from "react";

/** Keep input focus while navigating the current, selectable search results. */
export function useSearchNavigation({ ids, query, open = true, selectedId, ready = true, onSelect }: {
  ids: string[]; query: string; open?: boolean; selectedId?: string | null; ready?: boolean; onSelect: (id: string) => void;
}) {
  const listId = useId();
  const [target, setTarget] = useState<{ query: string; id: string } | null>(null);
  useEffect(() => { if (!open) setTarget(null); }, [open]);
  useEffect(() => { setTarget(null); }, [query]);
  const activeId = !open || !ready ? undefined
    : target?.query === query && ids.includes(target.id) ? target.id
    : !query && selectedId && ids.includes(selectedId) ? selectedId : ids[0];
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;
  useEffect(() => {
    if (activeId) document.getElementById(optionId(activeId))?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, listId, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || !open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!ready || !ids.length) return;
      const index = activeId ? ids.indexOf(activeId) : 0;
      const next = Math.max(0, Math.min(ids.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      setTarget({ query, id: ids[next]! });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (ready && activeId) onSelect(activeId);
    }
  };
  return {
    listId,
    inputProps: { role: "combobox" as const, "aria-expanded": open, "aria-controls": listId,
      "aria-autocomplete": "list" as const, "aria-activedescendant": activeId ? optionId(activeId) : undefined, onKeyDown },
    optionProps: (id: string) => ({ id: optionId(id), role: "option" as const, tabIndex: -1,
      "data-active": activeId === id || undefined, "aria-selected": activeId === id,
      onPointerMove: () => { if (ready) setTarget({ query, id }); } })
  };
}
