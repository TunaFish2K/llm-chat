import { useEffect } from "react";
import type { AppSettings } from "@llm-chat/contracts";
import { updateFavicon } from "./brand-icon";

export const THEME_COLORS = { dark: "#0d100e", light: "#f5f7f5" } as const;

/** Applies the theme from server settings to <html data-theme>. */
export function useTheme(settings: AppSettings | null): void {
  const theme = settings?.theme ?? "system";
  const accent = settings?.uiPreferences.accentColor;
  const amoled = settings?.uiPreferences.amoled ?? false;
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      root.dataset.theme = resolved;
      root.dataset.amoled = String(amoled && resolved === "dark");
      for (const name of ["--accent", "--accent-soft", "--accent-line", "--border-focus", "--text-invert"]) root.style.removeProperty(name);
      if (accent) {
        root.style.setProperty("--accent", accent);
        root.style.setProperty("--border-focus", accent);
        root.style.setProperty("--accent-soft", `${accent}20`);
        root.style.setProperty("--accent-line", `${accent}60`);
        const rgb = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        const luminance = rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
        root.style.setProperty("--text-invert", luminance > .179 ? "#000000" : "#ffffff");
      }
      root.style.colorScheme = resolved;
      updateFavicon(resolved, accent);
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", amoled && resolved === "dark" ? "#000000" : THEME_COLORS[resolved]);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, accent, amoled]);
}
