import { useState } from "react";
import { renderMessage, errorI18n } from "@llm-chat/i18n";
import { getLocale, useLocale, type DisplayMessage } from "./i18n";

export function displayError(value: unknown): string {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    const i18n = errorI18n(value);
    return renderMessage(getLocale(), { message: value.message, ...(i18n ? { i18n } : {}) });
  }
  return String(value);
}
export function useErrorState(initial: string | null = null): [string | null, (value: unknown) => void] {
  useLocale();
  const [value, setValue] = useState<unknown>(initial);
  return [value === null ? null : displayError(value), (next) => setValue(next)];
}
export function errorDisplayMessage(value: unknown): DisplayMessage {
  const i18n = errorI18n(value);
  return { message: value instanceof Error ? value.message : String(value), ...(i18n ? { i18n } : {}) };
}
