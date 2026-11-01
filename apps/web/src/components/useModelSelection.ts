import { useEffect, useState } from "react";

export function useModelSelection(scope: string, matchingIds: string[], displayedIds: string[]) {
  const [state, setState] = useState<{ scope: string; ids: Set<string>; anchor: string | null }>({ scope, ids: new Set(), anchor: null });
  useEffect(() => { setState({ scope, ids: new Set(), anchor: null }); }, [scope]);
  const selected = new Set(scope === state.scope ? matchingIds.filter(id => state.ids.has(id)) : []);
  const update = (ids: Set<string>, anchor: string | null = null) => setState({ scope, ids, anchor });
  return {
    selected,
    clear: () => update(new Set()),
    toggle: (id: string, range: boolean) => {
      const checked = !selected.has(id);
      const from = state.scope === scope && state.anchor ? displayedIds.indexOf(state.anchor) : -1;
      const to = displayedIds.indexOf(id);
      const targets = range && from >= 0 && to >= 0 ? displayedIds.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
      for (const target of targets) { if (checked) selected.add(target); else selected.delete(target); }
      update(selected, range && from >= 0 ? state.anchor : id);
    },
    selectGroup: (ids: string[]) => {
      const remove = ids.every(id => selected.has(id));
      for (const id of ids) { if (remove) selected.delete(id); else selected.add(id); }
      update(selected);
    },
    invert: () => update(new Set(matchingIds.filter(id => !selected.has(id))))
  };
}
