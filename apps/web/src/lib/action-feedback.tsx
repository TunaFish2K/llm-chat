import { resourceSaveStore } from "./optimistic-resource";
import { createStore, useStore } from "./store";
import { createContext, forwardRef, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type MouseEvent } from "react";

const groupStore = createStore<Record<string, boolean>>({});
const groupRefs = new Map<string, { current: boolean; version: number }>();
const ActionGroupContext = createContext<{ busy: { current: boolean; version: number }; setPending: (pending: boolean) => void } | null>(null);
export function ActionGroup({ actionKey, ...props }: HTMLAttributes<HTMLDivElement> & { actionKey?: string }) {
  const localId = useId(), key = actionKey ?? localId;
  const busy = groupRefs.get(key) ?? { current: false, version: 0 };
  groupRefs.set(key, busy);
  const pending = useStore(groupStore, (state) => state[key] ?? false);
  return <ActionGroupContext.Provider value={{ busy, setPending: (value) => groupStore.set({ [key]: value }) }}><div {...props} data-action-pending={pending || undefined} /></ActionGroupContext.Provider>;
}
window.addEventListener("llm-chat:submissions-clear", () => {
  for (const [key, ref] of groupRefs) { ref.current = false; ref.version++; groupStore.set({ [key]: false }); }
});

/** Keeps the original label and geometry while acknowledging an asynchronous click immediately. */
export const ActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function ActionButton(
  { onClick, disabled, children, ...props }, ref
) {
  const group = useContext(ActionGroupContext);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (busy.current || group?.busy.current || disabled) return;
    const result = onClick?.(event) as unknown;
    if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
    busy.current = true;
    const groupVersion = group ? ++group.busy.version : 0;
    if (group) { group.busy.current = true; group.setPending(true); }
    setPending(true);
    const timer = setTimeout(() => { if (mounted.current) setSlow(true); }, 200);
    void Promise.resolve(result).catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent("llm-chat:action-error", { detail: error }));
    }).finally(() => {
      clearTimeout(timer); busy.current = false;
      if (group && group.busy.version === groupVersion) { group.busy.current = false; group.setPending(false); }
      if (mounted.current) { setPending(false); setSlow(false); }
    });
  };
  // Announce pending work outside the disabled control.
  return <><button {...props} ref={ref} onClick={click} disabled={disabled || pending || group?.busy.current}
    data-action-pending={pending || undefined} data-action-slow={slow || undefined}>
    {children}
  </button>{pending ? <span className="sr-only" role="status">正在处理，请稍候</span> : null}</>;
});

export function ResourceSaveStatus({ resource }: { resource: string }) {
  const status = useStore(resourceSaveStore, (state) => state[resource]);
  return status === "saving" || status === "error" ? <span role="status" className="submission-status">{status === "saving" ? "正在保存…" : "保存失败，已恢复上次保存的设置"}</span> : null;
}
