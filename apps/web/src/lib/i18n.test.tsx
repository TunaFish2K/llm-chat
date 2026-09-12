import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguagePicker } from "../components/LanguagePicker";
import { getLocale, getLocaleState, localized, LOCALE_STORAGE_KEY, setLocalePreference, t, useLocale } from "./i18n";
import { useErrorState } from "./error-display";
import { ApiRequestError } from "./http-client";
import { formatTime } from "./format";

function Probe() {
  useLocale();
  const [error, setError] = useErrorState();
  return <><LanguagePicker /><input aria-label="draft" defaultValue="保留草稿" /><button onClick={() => setError(localized("directory.not_found"))}>Fail</button><output>{error}</output></>;
}
afterEach(() => { vi.restoreAllMocks(); });
it("switches immediately, preserves drafts and re-renders existing local errors", () => {
  render(<Probe />);
  act(() => screen.getByText("Fail").click());
  expect(screen.getByRole("status")).toHaveTextContent("目录不存在");
  act(() => setLocalePreference("en-US"));
  expect(document.documentElement.lang).toBe("en-US");
  expect(screen.getByLabelText("Language")).toHaveValue("en-US");
  expect(screen.getByRole("status")).toHaveTextContent("Directory not found");
  expect(screen.getByLabelText("draft")).toHaveValue("保留草稿");
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
});
it("follows browser language changes only in automatic mode and syncs other tabs", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr", "en-GB"]);
  act(() => setLocalePreference("system"));
  expect(getLocale()).toBe("en-US");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-TW"]);
  act(() => window.dispatchEvent(new Event("languagechange")));
  expect(getLocale()).toBe("zh-CN");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "en-US" })));
  act(() => window.dispatchEvent(new Event("languagechange")));
  expect(getLocale()).toBe("en-US");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "invalid" })));
  expect(getLocaleState().preference).toBe("system");
  expect(getLocale()).toBe("zh-CN");
});
it("continues in memory when storage is blocked and explains that it was not saved", () => {
  render(<LanguagePicker />);
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("blocked"); });
  act(() => setLocalePreference("en-US"));
  expect(getLocale()).toBe("en-US");
  expect(screen.getByRole("status")).toHaveTextContent("could not save the preference");
  expect(getLocaleState().saved).toBe(false);
});
it("renders API descriptors in the current language and leaves older errors intact", () => {
  const error = new ApiRequestError(401, "password_invalid", "密码错误", undefined, { key: "error.incorrect_password" });
  expect(error.message).toBe("密码错误");
  setLocalePreference("en-US");
  expect(error.message).toBe("Incorrect password");
  expect(new ApiRequestError(400, "external", "外部原文").message).toBe("外部原文");
  expect(t("locale.label")).toBe("Language");
  const date = Date.UTC(2026, 0, 2, 17, 6);
  expect(formatTime(date)).toBe(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).format(date));
});
