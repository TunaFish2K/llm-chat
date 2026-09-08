import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeSettings } from "../../test/fixtures";
import { THEME_COLORS, useTheme } from "./theme";

describe("useTheme", () => {
  it("keeps the document and browser chrome color in sync with the selected theme", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    const favicon = document.createElement("link");
    favicon.id = "app-favicon";
    document.head.append(favicon);
    const { rerender, unmount } = renderHook(
      ({ theme }) => useTheme(makeSettings({ theme })),
      { initialProps: { theme: "dark" as "dark" | "light" } }
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.content).toBe(THEME_COLORS.dark);
    expect(decodeURIComponent(favicon.href)).toContain('fill="#ff8964"');

    rerender({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe(THEME_COLORS.light);
    expect(decodeURIComponent(favicon.href)).toContain('fill="#c64b2f"');

    unmount();
    meta.remove();
    favicon.remove();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("updates the favicon for system theme changes and detaches its listener", () => {
    let listener!: () => void;
    const media = { matches: false, addEventListener: vi.fn((_event, callback) => { listener = callback; }), removeEventListener: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    const favicon = document.createElement("link"); favicon.id = "app-favicon"; document.head.append(favicon);
    const { unmount } = renderHook(() => useTheme(makeSettings({ theme: "system" })));
    expect(decodeURIComponent(favicon.href)).toContain('fill="#000000"');
    act(() => { media.matches = true; listener(); });
    expect(decodeURIComponent(favicon.href)).toContain('fill="#FFFFFF"');
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
    favicon.remove();
  });
});
