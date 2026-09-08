/**
 * The application shell: the three-column frame, its resize affordances, the
 * mobile drawers, and the toast stack. Nothing here knows about conversations
 * or Agents — it only arranges regions and reports geometry back to `App`.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Menu, PanelRightOpen, RefreshCw } from "lucide-react";
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
  return (
    <div className="boot-screen">
      <div className="boot-state">
        <div className="boot-brand">
          <img src="/icons/icon-192-v2.png" width={36} height={36} alt="" />
          <strong>Chat</strong>
        </div>
        {error ? (
          <ErrorState message={`无法连接服务：${error}`} onRetry={onRetry} />
        ) : (
          <LoadingState label="正在启动 Chat…" />
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
      aria-label={side === "left" ? "调整会话栏宽度" : "调整检查器宽度"}
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
  onOpenInspector
}: {
  title: string;
  onOpenNav: () => void;
  onOpenInspector: (() => void) | null;
}) {
  return (
    <header className="mobile-appbar">
      <IconButton label="打开导航" onClick={onOpenNav}>
        <Menu size={20} />
      </IconButton>
      <strong role="heading" aria-level={2}>
        {title}
      </strong>
      {onOpenInspector ? (
        <IconButton label="打开检查器" onClick={onOpenInspector}>
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
  const panelRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; at: number; dragging: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="mobile-drawer" data-side={side}>
      <button type="button" className="drawer-scrim" onClick={onClose} aria-label={closeLabel} />
      <div
        ref={panelRef}
        className="drawer-panel"
        data-dragging={dragging || undefined}
        style={{ transform: dragOffset ? `translateX(${dragOffset}px)` : undefined }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          gesture.current = { x: event.clientX, y: event.clientY, at: performance.now(), dragging: false };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.dragging) {
            if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
            start.dragging = true;
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          const closingOffset = side === "left" ? Math.min(0, dx) : Math.max(0, dx);
          setDragOffset(closingOffset);
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (!start) return;
          const elapsed = Math.max(1, performance.now() - start.at);
          const dx = event.clientX - start.x;
          const distance = Math.abs(side === "left" ? Math.min(0, dx) : Math.max(0, dx));
          const width = panelRef.current?.offsetWidth ?? 320;
          const velocity = distance / elapsed;
          gesture.current = null;
          setDragging(false);
          if (start.dragging && (distance >= Math.max(56, width * 0.22) || velocity >= 0.55)) onClose();
          else setDragOffset(0);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setDragging(false);
          setDragOffset(0);
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* Notifications ----------------------------------------------------------- */

export function ToastStack({
  toasts,
  updateAvailable,
  onApplyUpdate
}: {
  toasts: Toast[];
  updateAvailable: boolean;
  onApplyUpdate: () => void;
}) {
  return (
    <div className="toast-stack" aria-live="polite">
      {updateAvailable ? (
        <div className="toast info">
          <RefreshCw size={16} aria-hidden="true" />
          <span>新版本已准备好</span>
          <Button variant="primary" size="sm" onClick={onApplyUpdate}>
            更新
          </Button>
        </div>
      ) : null}
      {toasts.map((item) => (
        <div
          key={item.id}
          className={`toast ${item.kind}`}
          role={item.kind === "error" ? "alert" : "status"}
        >
          {item.text}
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
    if (!route.conversationId) return "新会话";
    const conversation = conversations.find((item) => item.id === route.conversationId);
    if (!conversation) return "会话";
    return resolveConversationRoot(conversation, conversations).title;
  }
  if (route.name === "agents") {
    if (!route.agentId) return "Agent";
    return agents.find((item) => item.id === route.agentId)?.name ?? "Agent";
  }
  if (route.name === "tasks") return "后台任务";
  return "设置";
}
