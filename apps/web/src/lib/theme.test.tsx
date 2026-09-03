import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeSettings } from "../../test/fixtures";
import { THEME_COLORS, useTheme } from "./theme";

describe("useTheme", () => {
  it("keeps the document and browser chrome color in sync with the selected theme", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    const { rerender, unmount } = renderHook(
      ({ theme }) => useTheme(makeSettings({ theme })),
      { initialProps: { theme: "dark" as "dark" | "light" } }
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.content).toBe(THEME_COLORS.dark);

    rerender({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe(THEME_COLORS.light);

    unmount();
    meta.remove();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("color-scheme");
  });
});
