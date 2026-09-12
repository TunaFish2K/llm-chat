import { createInstance } from "i18next";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

export type Locale = "zh-CN" | "en-US";
export type LocalePreference = Locale | "system";
export type MessageKey = keyof typeof zhCN;
export interface LocalizedMessage { key: MessageKey; params?: Record<string, string | number> }
export const resources = { "zh-CN": { translation: zhCN }, "en-US": { translation: enUS } };
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en-US";
  }
  return "en-US";
}
export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || value === "zh-CN" || value === "en-US";
}
export function createI18n(locale: Locale) {
  const instance = createInstance();
  void instance.init({ resources, lng: locale, fallbackLng: "en-US", initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
  return instance;
}
const translators = { "zh-CN": createI18n("zh-CN"), "en-US": createI18n("en-US") };
export function translate(locale: Locale, key: MessageKey, params?: Record<string, unknown>): string {
  return translators[locale].t(key, { original: "{{original}}", ...params }) as string;
}

/** Attach display metadata without changing existing error messages or classes. */
export function withMessage<T extends Error>(error: T, key: MessageKey, params?: Record<string, unknown>): T & { i18n: LocalizedMessage } {
  const values = params && Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === "number" ? value : String(value)]));
  return Object.assign(error, { i18n: { key, ...(values ? { params: values } : {}) } });
}
export function errorI18n(value: unknown): LocalizedMessage | undefined {
  if (!value || typeof value !== "object" || !("i18n" in value)) return undefined;
  const descriptor = value.i18n;
  if (!descriptor || typeof descriptor !== "object" || !("key" in descriptor) || typeof descriptor.key !== "string" || !Object.hasOwn(zhCN, descriptor.key)) return undefined;
  if ("params" in descriptor && descriptor.params !== undefined && (!descriptor.params || typeof descriptor.params !== "object" || Array.isArray(descriptor.params) || Object.values(descriptor.params).some((item) => typeof item !== "string" && typeof item !== "number"))) return undefined;
  return descriptor as LocalizedMessage;
}
export function renderMessage(locale: Locale, value: { message: string; i18n?: LocalizedMessage }): string {
  const descriptor = errorI18n(value);
  return descriptor ? translate(locale, descriptor.key, descriptor.params) : value.message;
}
