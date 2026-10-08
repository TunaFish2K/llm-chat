import { afterEach, describe, expect, it, vi } from "vitest";
import { LAST_ROUTE_KEY, rememberLaunchRoute, RESTORE_WINDOW, restoreLaunchRoute } from "./launch-route";

function installed(matches = true, type: NavigationTimingType = "navigate") {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches, media: query } as MediaQueryList));
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type } as PerformanceNavigationTiming]);
}

function saveRoute(path: string, age = 0) {
  localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ path, at: Date.now() - age }));
}

describe("launch route", () => {
  afterEach(() => { window.history.replaceState(null, "", "/"); });

  it("reopens the last route when the installed app launches at start_url", () => {
    installed();
    window.history.replaceState(null, "", "/");
    saveRoute("/c/recent", 60_000);
    restoreLaunchRoute();
    expect(location.pathname).toBe("/c/recent");
  });

  it("starts fresh after the restore window, in a browser tab, on reload, or for deep links", () => {
    saveRoute("/c/recent", RESTORE_WINDOW + 1);
    installed();
    restoreLaunchRoute();
    expect(location.pathname).toBe("/");

    saveRoute("/c/recent");
    installed(false);
    restoreLaunchRoute();
    expect(location.pathname).toBe("/");

    vi.restoreAllMocks();
    installed(true, "reload");
    restoreLaunchRoute();
    expect(location.pathname).toBe("/");

    vi.restoreAllMocks();
    installed();
    window.history.replaceState(null, "", "/?notification=1");
    restoreLaunchRoute();
    expect(location.pathname).toBe("/");
    window.history.replaceState(null, "", "/c/opened");
    restoreLaunchRoute();
    expect(location.pathname).toBe("/c/opened");
  });

  it("ignores corrupt or foreign paths", () => {
    installed();
    for (const value of ["invalid", JSON.stringify({ path: "//evil.example", at: Date.now() }), JSON.stringify({ path: 4, at: Date.now() })]) {
      localStorage.setItem(LAST_ROUTE_KEY, value);
      restoreLaunchRoute();
      expect(location.pathname).toBe("/");
    }
  });

  it("records route changes and the time the app was left", () => {
    installed();
    window.history.replaceState(null, "", "/settings/general");
    rememberLaunchRoute();
    expect(JSON.parse(localStorage.getItem(LAST_ROUTE_KEY)!).path).toBe("/settings/general");
    window.history.pushState(null, "", "/c/next");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(JSON.parse(localStorage.getItem(LAST_ROUTE_KEY)!).path).toBe("/c/next");
    localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ path: "/c/next", at: 0 }));
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem(LAST_ROUTE_KEY)!).at).toBeGreaterThan(0);
  });
});
