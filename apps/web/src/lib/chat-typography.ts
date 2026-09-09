import { useLayoutEffect } from "react";
import { initializeTypography, typographyStore } from "./local-typography";
import { useStore } from "./store";
import type { AppSettings } from "@llm-chat/contracts";

export function useChatTypography(settings: AppSettings | null): void {
  const values = useStore(typographyStore, (state) => state.values);
  useLayoutEffect(() => { initializeTypography(settings?.uiPreferences); }, [settings]);
  const { chatFontSize: size, chatLetterSpacing: spacing, chatLineHeight: height } = values;
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("llm-chat:before-typography"));
    const style = document.documentElement.style;
    style.setProperty("--chat-font-size", `${size}px`);
    style.setProperty("--chat-letter-spacing", `${spacing}em`);
    style.setProperty("--chat-line-height", String(height));
    for (const base of [11, 12, 14, 16, 18, 20]) style.setProperty(`--chat-size-${base}`, `${size * base / 13.5}px`);
    window.dispatchEvent(new Event("llm-chat:after-typography"));
  }, [size, spacing, height]);
}
