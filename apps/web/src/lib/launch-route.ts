/**
 * An installed app launches at start_url after the OS kills its process. A
 * native app would reopen where the user left, so remember the last route and
 * restore it on a fresh launch. Browser tabs and deep links are left alone.
 */
export const LAST_ROUTE_KEY = "llm-chat.last-route.v1";
export const RESTORE_WINDOW = 12 * 60 * 60 * 1000;

interface LastRoute { path: string; at: number }

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

function freshLaunch(): boolean {
  const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return !entry || entry.type === "navigate";
}

function readLastRoute(): LastRoute | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY) ?? "null") as Partial<LastRoute> | null;
    if (typeof value?.path !== "string" || typeof value.at !== "number") return null;
    return { path: value.path, at: value.at };
  } catch { return null; }
}

/** Run before the first render so the router and bootstrap see the restored path. */
export function restoreLaunchRoute(): void {
  if (!standalone() || !freshLaunch()) return;
  if (location.pathname !== "/" || location.search || location.hash) return;
  const last = readLastRoute();
  if (!last || !last.path.startsWith("/") || last.path.startsWith("//") || last.path === "/") return;
  if (Date.now() - last.at >= RESTORE_WINDOW) return;
  history.replaceState(null, "", last.path);
}

export function rememberLaunchRoute(): void {
  if (!standalone()) return;
  const save = () => {
    try { localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ path: location.pathname, at: Date.now() })); } catch {}
  };
  save();
  window.addEventListener("popstate", save);
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
}
