import { animate, drawerSpring, m, motionTiming, useMotionValue, usePresence, useReducedMotion, useTransform } from "../../lib/motion";
import { displayError } from "../../lib/error-display";
import { t, useLocale } from "../../lib/i18n";
/**
 * The application shell: the three-column frame, its resize affordances, the
 * mobile drawers, and the toast stack. Nothing here knows about conversations
 * or Agents — it only arranges regions and reports geometry back to `App`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useBackLayer } from "../../lib/mobile-navigation";
import { ArrowLeft, Menu, PanelRightOpen, RefreshCw } from "lucide-react";
import type { ConversationDto } from "@llm-chat/contracts";
import type { Toast } from "../../lib/app-state";
import { resolveConversationRoot } from "../../lib/conversation-tree";
import type { Route } from "../../lib/router";
import { Button, ErrorState, IconButton, LoadingState } from "../ui";

/* Geometry ---------------------------------------------------------------- */

export const LEFT_MIN = 224;
export const LEFT_MAX = 380;
export const RIGHT_MIN = 300;
export const RIGHT_MAX = 560;
/** Width of the sidebar when collapsed to icons. */
export const RAIL_WIDTH = 64;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A number persisted in localStorage and always clamped into range. */
export function useStoredNumber(
  key: string,
  fallback: number,
  min: number,
  max: number
): [number, (value: number) => void] {
  useLocale();
  const [value, setValue] = useState(() => {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clamp(stored, min, max) : fallback;
  });
  const store = useCallback(
    (next: number) => {
      const safe = clamp(next, min, max);
      setValue(safe);
      localStorage.setItem(key, String(safe));
    },
    [key, min, max]
  );
  return [value, store];
}

export function useMediaQuery(query: string): boolean {
  useLocale();
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/* Frame ------------------------------------------------------------------- */

export function BootScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  useLocale();
  return (
    <div className="boot-screen">
      <div className="boot-state">
        <div className="boot-brand">
          <img src="/icons/icon-192-v2.png" width={36} height={36} alt="" />
          <strong>Chat</strong>
        </div>
        {error ? (
          <ErrorState message={t("index.could_not_connect_to_the_service", { value1: (error) })} onRetry={onRetry} />
        ) : (
          <LoadingState label={t("index.starting_chat")} />
        )}
      </div>
    </div>
  );
}

export function AppFrame({
  left,
  right,
  sidebarCollapsed,
  inspectorOpen,
  children
}: {
  left: number;
  right: number;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  children: ReactNode;
}) {
  useLocale();
  return (
    <div
      className="app-frame"
      style={{ gridTemplateColumns: `${left}px minmax(0, 1fr) ${right}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-inspector-open={inspectorOpen || undefined}
    >
      {children}
    </div>
  );
}

/**
 * Draggable column divider. It is also a real `separator` widget: arrow keys
 * move it in 16 px steps so the layout is adjustable without a pointer.
 */
export function ResizeHandle({
  side,
  position,
  value,
  min,
  max,
  onChange
}: {
  side: "left" | "right";
  position: number;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  useLocale();
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startValue = value;
    const move = (next: PointerEvent) => {
      const delta = next.clientX - startX;
      onChange(clamp(startValue + (side === "left" ? delta : -delta), min, max));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };

  return (
    <div
      className="resize-handle"
      data-side={side}
      style={side === "left" ? { left: position - 2 } : { right: position - 2 }}
      role="separator"
      aria-label={side === "left" ? t("index.resize_conversation_sidebar") : t("index.resize_inspector")}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 16 : -16;
        onChange(clamp(value + (side === "left" ? delta : -delta), min, max));
      }}
    />
  );
}

/* Mobile ------------------------------------------------------------------ */

export function MobileAppBar({
  title,
  onOpenNav,
  onOpenInspector,
  onBack
}: {
  title: string;
  onOpenNav: () => void;
  onOpenInspector: (() => void) | null;
  onBack?: (() => void) | undefined;
}) {
  useLocale();
  return (
    <header className="mobile-appbar">
      <IconButton label={onBack ? t("index.go_back") : t("index.open_navigation")} onClick={onBack ?? onOpenNav}>
        {onBack ? <ArrowLeft size={20} /> : <Menu size={20} />}
      </IconButton>
      <strong role="heading" aria-level={2}>
        {title}
      </strong>
      {onOpenInspector ? (
        <IconButton label={t("index.open_inspector")} onClick={onOpenInspector}>
          <PanelRightOpen size={19} />
        </IconButton>
      ) : (
        <span />
      )}
    </header>
  );
}

export function MobileDrawer({
  side,
  closeLabel,
  onClose,
  children
}: {
  side: "left" | "right";
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useLocale();
  const [present, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; at: number; offset: number; dragging: boolean } | null>(null);
  const closing = useRef(false);
  const suppressClick = useRef(false);
  const x = useMotionValue(0);
  const width = useMotionValue(320);
  const opacity = useTransform(() => Math.max(0, 1 - Math.abs(x.get()) / width.get()));
  const animation = useRef<ReturnType<typeof animate> | null>(null);
  const initialized = useRef(false);
  const close = () => {
    if (!present || closing.current) return;
    closing.current = true;
    onClose();
  };
  useBackLayer(true, close, 10);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (!next || next === width.get()) return;
      width.set(next);
      if (initialized.current && gesture.current) {
        gesture.current = null;
        animation.current?.stop();
        x.set(0);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, x]);

  useLayoutEffect(() => {
    let active = true;
    animation.current?.stop();
    gesture.current = null;
    if (!initialized.current) {
      x.set(reduced ? 0 : (side === "left" ? -1 : 1) * width.get());
      initialized.current = true;
    }
    if (present) closing.current = false;
    const target = present ? 0 : (side === "left" ? -1 : 1) * width.get();
    if (reduced) {
      x.set(target);
      if (!present) safeToRemove?.();
    } else {
      animation.current = animate(x, target, present ? drawerSpring : { duration: motionTiming.exit });
      if (!present) void animation.current.then(() => { if (active) safeToRemove?.(); });
    }
    return () => { active = false; animation.current?.stop(); };
  }, [present, reduced, side, safeToRemove, width, x]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cancel = () => {
    if (!gesture.current) return;
    gesture.current = null;
    animation.current?.stop();
    if (reduced) x.set(0);
    else animation.current = animate(x, 0, drawerSpring);
  };

  return (
    <div className="mobile-drawer" data-side={side} data-exiting={!present || undefined}
      onClickCapture={(event) => {
        if (!present || (suppressClick.current && event.detail > 0)) {
          event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
        }
      }}>
      <m.button type="button" className="drawer-scrim" style={{ opacity }} onClick={close} aria-label={closeLabel} />
      <m.div ref={panelRef} className="drawer-panel" style={{ x }} inert={!present ? true : undefined}
        onPointerDown={(event) => {
          if (!present || closing.current || (event.pointerType === "mouse" && event.button !== 0)) return;
          suppressClick.current = false;
          const target = event.target as Element;
          if (target.closest("input, textarea, select, [contenteditable=true], [role=slider], [data-no-back-gesture]")) return;
          if (window.getSelection()?.toString()) return;
          for (let node: Element | null = target; node && node !== event.currentTarget; node = node.parentElement) {
            if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
          }
          gesture.current = { x: event.clientX, y: event.clientY, at: performance.now(), offset: x.get(), dragging: false };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start) return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (!start.dragging) {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { gesture.current = null; return; }
            if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
            start.dragging = true;
            suppressClick.current = true;
            animation.current?.stop();
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          const offset = start.offset + dx;
          x.set(side === "left" ? Math.max(-width.get(), Math.min(0, offset)) : Math.min(width.get(), Math.max(0, offset)));
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (!start) return;
          const elapsed = Math.max(1, performance.now() - start.at);
          const dx = event.clientX - start.x;
          const closingDistance = side === "left" ? Math.max(0, -dx) : Math.max(0, dx);
          const distance = Math.abs(x.get());
          gesture.current = null;
          if (start.dragging && closingDistance > 0 && (distance >= Math.max(56, width.get() * 0.22) || closingDistance / elapsed >= 0.55)) close();
          else if (reduced) x.set(0);
          else animation.current = animate(x, 0, drawerSpring);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancel} onLostPointerCapture={event => { if (event.target === event.currentTarget) cancel(); }}
      >{children}</m.div>
    </div>
  );
}

/* Notifications ----------------------------------------------------------- */

export function ToastStack({
  toasts,
  updateAvailable,
  onApplyUpdate,
  updating = false,
  updateError
}: {
  toasts: Toast[];
  updateAvailable: boolean;
  onApplyUpdate: () => void;
  updating?: boolean;
  updateError?: string | null;
}) {
  useLocale();
  return (
    <div className="toast-stack" aria-live="polite">
      {updateAvailable ? (
        <div className="toast info">
          <RefreshCw size={16} aria-hidden="true" />
          <span role={updateError ? "alert" : "status"}>{updateError ?? (updating ? t("SettingsView.applying_the_new_version") : t("index.new_version_ready"))}</span>
          <Button variant="primary" size="sm" onClick={onApplyUpdate} disabled={updating}>{t("SettingsView.update_and_refresh")}</Button>
        </div>
      ) : null}
      {toasts.map((item) => (
        <div
          key={item.id}
          className={`toast ${item.kind}`}
          role={item.kind === "error" ? "alert" : "status"}
        >
          {displayError({ message: item.text, ...(item.i18n ? { i18n: item.i18n } : {}) })}
        </div>
      ))}
    </div>
  );
}

/* Titles ------------------------------------------------------------------ */

export function routeTitle(
  route: Route,
  conversations: ReadonlyArray<ConversationDto>,
  agents: ReadonlyArray<{ id: string; name: string }>
): string {
  if (route.name === "chat") {
    if (!route.conversationId) return t("WorkspaceSidebar.new_conversation");
    const conversation = conversations.find((item) => item.id === route.conversationId);
    if (!conversation) return t("SettingsView.conversation");
    return resolveConversationRoot(conversation, conversations).title;
  }
  if (route.name === "agents") {
    if (!route.agentId) return "Agent";
    return agents.find((item) => item.id === route.agentId)?.name ?? "Agent";
  }
  if (route.name === "tasks") return t("TrajectoryView.background_tasks");
  return t("WorkspaceSidebar.settings");
}
