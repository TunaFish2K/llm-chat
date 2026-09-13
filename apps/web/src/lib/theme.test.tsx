import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DISPLAY_DEFAULTS, type DisplayPreferences } from "./local-display";
import { THEME_COLORS, useTheme } from "./theme";

describe("useTheme", () => {
  it("applies a custom accent and limits pure black to dark mode", () => {
    const favicon = document.createElement("link");
    favicon.id = "app-favicon";
    favicon.href = "/icons/icon-v2.svg";
    document.head.append(favicon);
    const settings: DisplayPreferences = { ...DISPLAY_DEFAULTS, theme: "dark", accentColor: "#018EEE", amoled: true };
    const { rerender } = renderHook(({ value }) => useTheme(value), { initialProps: { value: settings } });
    expect(document.documentElement.dataset.amoled).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#018EEE");
    expect(document.documentElement.style.getPropertyValue("--text-invert")).toBe("#000000");
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");
    rerender({ value: { ...settings, theme: "light" } });
    expect(document.documentElement.dataset.amoled).toBe("false");
    rerender({ value: { ...settings, accentColor: null } });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");
    favicon.remove();
  });

  it("keeps the document and browser chrome color in sync with the selected theme", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    const favicon = document.createElement("link");
    favicon.id = "app-favicon";
    favicon.href = "/icons/icon-v2.svg";
    document.head.append(favicon);
    const { rerender, unmount } = renderHook(
      ({ theme }) => useTheme({ ...DISPLAY_DEFAULTS, theme }),
      { initialProps: { theme: "dark" as "dark" | "light" } }
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.content).toBe(THEME_COLORS.dark);
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");

    rerender({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe(THEME_COLORS.light);
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");

    unmount();
    meta.remove();
    favicon.remove();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("follows system theme changes without changing the favicon and detaches its listener", () => {
    let listener!: () => void;
    const media = { matches: false, addEventListener: vi.fn((_event, callback) => { listener = callback; }), removeEventListener: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    const favicon = document.createElement("link"); favicon.id = "app-favicon"; favicon.href = "/icons/icon-v2.svg"; document.head.append(favicon);
    const { unmount } = renderHook(() => useTheme(DISPLAY_DEFAULTS));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");
    act(() => { media.matches = true; listener(); });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(favicon.getAttribute("href")).toBe("/icons/icon-v2.svg");
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
    favicon.remove();
  });
});
