let quietAfter = 0;
export function noteInteraction() { quietAfter = performance.now() + 600; }

/** Background history waits for an idle frame and yields to foreground input. */
export function scheduleBackgroundTask(action: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const schedule = () => {
    if (cancelled) return;
    const wait = quietAfter - performance.now();
    if (wait > 0) { timer = setTimeout(schedule, wait); return; }
    if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(deadline => {
        if (cancelled) return;
        if (quietAfter > performance.now() || deadline.timeRemaining() < 4) { timer = setTimeout(schedule, 16); return; }
        action();
      });
    } else timer = setTimeout(() => { if (!cancelled) action(); }, 16);
  };
  schedule();
  return () => { cancelled = true; clearTimeout(timer); if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle); };
}
