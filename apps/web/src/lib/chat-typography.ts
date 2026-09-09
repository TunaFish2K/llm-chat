import { useLayoutEffect } from "react";
import type { AppSettings } from "@llm-chat/contracts";

export function useChatTypography(settings: AppSettings | null): void {
  const size = settings?.uiPreferences.chatFontSize ?? 13.5;
  const spacing = settings?.uiPreferences.chatLetterSpacing ?? 0;
  const height = settings?.uiPreferences.chatLineHeight ?? 1.55;
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
