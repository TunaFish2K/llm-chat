import { useEffect } from "react";
import type { AppSettings } from "@llm-chat/contracts";

/** Applies the theme from server settings to <html data-theme>. */
export function useTheme(settings: AppSettings | null): void {
  const theme = settings?.theme ?? "system";
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
