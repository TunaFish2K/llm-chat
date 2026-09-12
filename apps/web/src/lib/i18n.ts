import { useSyncExternalStore } from "react";
import { initReactI18next } from "react-i18next";
import { createI18n, isLocalePreference, resolveLocale, type Locale, type LocalePreference, type MessageKey } from "@llm-chat/i18n";
export type { Locale, LocalePreference, MessageKey } from "@llm-chat/i18n";

export const LOCALE_STORAGE_KEY = "llm-chat.locale.v1";
const listeners = new Set<() => void>();
const browserLocale = (): Locale => resolveLocale(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);
let preference: LocalePreference = "system";
try { const stored = (typeof window === "undefined" ? undefined : window.localStorage)?.getItem(LOCALE_STORAGE_KEY); if (isLocalePreference(stored)) preference = stored; } catch { /* Memory preference remains available. */ }
let snapshot = { preference, locale: preference === "system" ? browserLocale() : preference, saved: true };
export const i18n = createI18n(snapshot.locale);
initReactI18next.init(i18n);
export function t(key: MessageKey, params?: Record<string, unknown>): string {
  return i18n.t(key, { original: "{{original}}", ...params }) as string;
}
export function getLocale(): Locale { return snapshot.locale; }
export function getLocaleState() { return snapshot; }
export function subscribeLocale(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLocale() { return useSyncExternalStore(subscribeLocale, getLocaleState, getLocaleState); }
function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = snapshot.locale;
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("app.description"));
  const manifest = document.querySelector('link[rel="manifest"]');
  manifest?.setAttribute("href", `/manifest.${snapshot.locale}.webmanifest`);
}
function update(next: LocalePreference, saved: boolean) {
  const locale = next === "system" ? browserLocale() : next;
  snapshot = { preference: next, locale, saved };
  void i18n.changeLanguage(locale);
  updateDocument();
  for (const listener of listeners) listener();
}
export function setLocalePreference(next: LocalePreference) {
  let saved = true;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { saved = false; }
  update(next, saved);
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) update(isLocalePreference(event.newValue) ? event.newValue : "system", true);
  });
  window.addEventListener("languagechange", () => { if (snapshot.preference === "system") update("system", snapshot.saved); });
  updateDocument();
}

export interface DisplayMessage { message: string; i18n?: import("@llm-chat/i18n").LocalizedMessage }
export function localized(key: MessageKey, params?: Record<string, unknown>): DisplayMessage {
  const values = params && Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === "number" ? value : String(value)]));
  return { message: t(key, params), i18n: { key, ...(values ? { params: values } : {}) } };
}

/** Keep message metadata when an asynchronous operation creates an Error. */
export function localizedError(key: MessageKey, params?: Record<string, unknown>): Error {
  return Object.assign(new Error(t(key, params)), { i18n: localized(key, params).i18n });
}
