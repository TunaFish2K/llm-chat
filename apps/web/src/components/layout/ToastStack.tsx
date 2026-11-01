import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { RefreshCw, X } from "lucide-react";
import { m, Presence, useIsPresent, useReducedMotion } from "../../lib/motion";
import { useAnimationDuration } from "../../lib/animation-preferences";
import { displayError } from "../../lib/error-display";
import { t, useLocale } from "../../lib/i18n";
import type { Toast } from "../../lib/toast-state";
import { Button, IconButton } from "../ui";

/** Anchor inside the main column, below visible page navigation, without reflow. */
function useToastPosition(ref: RefObject<HTMLDivElement | null>) {
  const [position, setPosition] = useState<CSSProperties>({ top: 8 });
  const [obscured, setObscured] = useState(false);
  useLayoutEffect(() => {
    const main = ref.current?.closest(".workspace-main");
    if (!main) return;
    let frame = 0;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(() => schedule());
    const measure = () => {
      const bounds = main.getBoundingClientRect();
      let bottom = 0;
      const headers = main.querySelectorAll('[data-toast-boundary], :scope > .page-header');
      for (const header of headers) {
        if (!header.getClientRects().length || header.closest('[hidden], [aria-hidden="true"]')) continue;
        bottom = Math.max(bottom, header.getBoundingClientRect().bottom - bounds.top);
        if (!observed.has(header)) { resize.observe(header); observed.add(header); }
      }
      for (const header of observed) if (!main.contains(header)) { resize.unobserve(header); observed.delete(header); }
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--toast-safe-top")) || 0;
      const top = Math.max(bottom + 8, safeTop + 8);
      const available = (viewport?.offsetTop ?? 0) + height - bounds.top - top - 12;
      const maxHeight = Math.max(0, Math.min(height * .35, available));
      setPosition(previous => previous.top === top && previous.maxHeight === maxHeight ? previous : { top, maxHeight });
      setObscured([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some(dialog => dialog.getClientRects().length > 0 && !dialog.closest('[aria-hidden="true"], [inert]')));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    resize.observe(main);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "inert", "class"] });
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [ref]);
  return { position, obscured };
}

export function ToastStack({ toasts, onDismiss, onPresentationChange, updateAvailable, onApplyUpdate, updating = false, updateError, suspended = false }: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onPresentationChange: (ids: number[], paused: boolean) => void;
  updateAvailable: boolean;
  onApplyUpdate: () => void;
  updating?: boolean;
  updateError?: string | null;
  suspended?: boolean;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { position, obscured } = useToastPosition(ref);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<Set<number>>(new Set());
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(false);
  const [background, setBackground] = useState(document.visibilityState === "hidden");
  const visible = expanded ? [...toasts].reverse() : toasts.slice(-1);
  const ids = visible.map(item => item.id).join(",");
  const paused = suspended || obscured || background || hovered || focused || selected || expanded || visible.some(item => details.has(item.id));
  useEffect(() => {
    onPresentationChange(ids ? ids.split(",").map(Number) : [], paused);
  }, [ids, paused, onPresentationChange]);
  useEffect(() => () => onPresentationChange([], true), [onPresentationChange]);
  useEffect(() => {
    const selection = () => {
      const range = window.getSelection();
      setSelected(Boolean(range && !range.isCollapsed && (ref.current?.contains(range.anchorNode) || ref.current?.contains(range.focusNode))));
    };
    const visibility = () => setBackground(document.visibilityState === "hidden");
    document.addEventListener("selectionchange", selection);
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("selectionchange", selection); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (toasts.length < 2) setExpanded(false);
    setDetails(previous => {
      const next = new Set([...previous].filter(id => toasts.some(item => item.id === id)));
      return next.size === previous.size ? previous : next;
    });
    if (!toasts.length && !updateAvailable) { setHovered(false); setFocused(false); setSelected(false); }
  }, [toasts, updateAvailable]);
  useLayoutEffect(() => { setFocused(Boolean(ref.current?.contains(document.activeElement))); }, [ids]);
  const detail = (id: number, open: boolean) => setDetails(previous => {
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
  });

  return <div ref={ref} className="toast-stack" style={position} hidden={suspended} inert={obscured || undefined}
    onPointerEnter={event => { if (event.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {updateAvailable ? <div className="toast info toast-update">
      <RefreshCw size={16} aria-hidden="true" />
      <span role={updateError ? "alert" : "status"}>{updateError ? t("ToastStack.update_failed") : updating ? t("SettingsView.applying_the_new_version") : t("index.new_version_ready")}</span>
      <Button variant="primary" size="sm" onClick={onApplyUpdate} disabled={updating}>{t("SettingsView.update_and_refresh")}</Button>
    </div> : null}
    <div id={listId} className="toast-list">
      <Presence>{visible.map(item => <ToastItem key={item.id} item={item} expanded={details.has(item.id)} onExpand={open => detail(item.id, open)} onDismiss={() => onDismiss(item.id)} />)}</Presence>
    </div>
    {toasts.length > 1 ? <button className="toast-more" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
      {expanded ? t("ToastStack.collapse") : t("ToastStack.more", { count: toasts.length - 1 })}
    </button> : null}
  </div>;
}

function ToastItem({ item, expanded, onExpand, onDismiss }: { item: Toast; expanded: boolean; onExpand: (open: boolean) => void; onDismiss: () => void }) {
  const present = useIsPresent();
  const text = displayError({ message: item.text, ...(item.i18n ? { i18n: item.i18n } : {}) });
  const ref = useRef<HTMLSpanElement>(null);
  const messageId = useId();
  const [overflow, setOverflow] = useState(false);
  const enter = useAnimationDuration("toast") / 1_000;
  const exit = useAnimationDuration("toast", "exit") / 1_000;
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [text, expanded]);
  return <m.div className={`toast ${item.kind}`} data-toast-id={item.id} role={item.kind === "error" ? "alert" : "status"}
    aria-hidden={!present || undefined} inert={!present || undefined}
    initial={{ opacity: reduced || !enter ? 1 : 0, y: reduced || !enter ? 0 : -4 }}
    animate={{ opacity: 1, y: 0, transition: { duration: reduced ? 0 : enter } }}
    exit={{ opacity: 0, transition: { duration: reduced ? 0 : exit } }}>
    <div className="toast-body">
      <span ref={ref} id={messageId} className="toast-message" data-expanded={expanded || undefined}>{text}</span>
      {item.count > 1 ? <span className="toast-count" aria-label={t("ToastStack.repeated", { count: item.count })}>×{item.count}</span> : null}
      {overflow || expanded ? <button className="toast-details" aria-expanded={expanded} aria-controls={messageId} onClick={() => onExpand(!expanded)}>{t(expanded ? "ToastStack.less_detail" : "ToastStack.detail")}</button> : null}
    </div>
    <IconButton label={t("ToastStack.dismiss")} onClick={onDismiss}><X size={15} /></IconButton>
  </m.div>;
}
