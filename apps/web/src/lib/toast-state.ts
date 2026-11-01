import { dequal } from "dequal";
import type { DisplayMessage } from "./i18n";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  i18n?: DisplayMessage["i18n"];
  count: number;
  remainingMs: number;
}

const LIFETIME = 5_000;

/** Timers run only for presented notifications; the store also owns paused time. */
export function createToastController(read: () => Toast[], write: (toasts: Toast[]) => void) {
  let sequence = 0;
  let visible = new Set<number>();
  let paused = false;
  const timers = new Map<number, { started: number; handle: ReturnType<typeof setTimeout> }>();
  const stop = (id: number) => {
    const timer = timers.get(id);
    if (timer) { clearTimeout(timer.handle); timers.delete(id); }
    return timer ? Date.now() - timer.started : 0;
  };
  const dismiss = (id: number) => {
    stop(id);
    write(read().filter(item => item.id !== id));
  };
  const sync = () => {
    const items = read();
    for (const id of timers.keys()) if (!items.some(item => item.id === id)) stop(id);
    for (const item of items) {
      if (paused || !visible.has(item.id) || timers.has(item.id)) continue;
      timers.set(item.id, { started: Date.now(), handle: setTimeout(() => dismiss(item.id), item.remainingMs) });
    }
  };
  return {
    push(kind: Toast["kind"], value: string | DisplayMessage) {
      const text = typeof value === "string" ? value : value.message;
      const i18n = typeof value === "string" ? undefined : value.i18n;
      const previous = read().find(item => item.kind === kind && item.text === text && dequal(item.i18n, i18n));
      if (previous) stop(previous.id);
      const item: Toast = { id: previous?.id ?? ++sequence, kind, text, ...(i18n ? { i18n } : {}), count: (previous?.count ?? 0) + 1, remainingMs: LIFETIME };
      write([...read().filter(existing => existing.id !== item.id), item].slice(-5));
      sync();
    },
    dismiss,
    present(ids: number[], nextPaused = false) {
      visible = new Set(ids);
      paused = nextPaused;
      let changed = false;
      const next = read().map(item => {
        if (!timers.has(item.id) || (!paused && visible.has(item.id))) return item;
        const elapsed = stop(item.id);
        if (!elapsed) return item;
        changed = true;
        return { ...item, remainingMs: Math.max(0, item.remainingMs - elapsed) };
      });
      if (changed) write(next);
      sync();
    }
  };
}
