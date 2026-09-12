import { describe, expect, it } from "vitest";
import { errorI18n, isLocalePreference, renderMessage, resolveLocale, resources, translate, withMessage } from "./index";
import { localizedToolFormatters } from "./tool-presentation";

describe("language resources", () => {
  it.each([
    [["fr-FR", "zh-TW", "en-US"], "zh-CN"], [["en-GB", "zh-CN"], "en-US"],
    [["ZH-hans"], "zh-CN"], [["fr-FR"], "en-US"], [[], "en-US"]
  ] as const)("resolves browser languages %j", (languages, expected) => expect(resolveLocale(languages)).toBe(expected));
  it("validates saved preferences", () => {
    expect(["system", "zh-CN", "en-US"].every(isLocalePreference)).toBe(true);
    expect([null, "zh-TW", {}, ""].some(isLocalePreference)).toBe(false);
  });
  it("keeps catalog keys and interpolation placeholders aligned", () => {
    const zh = resources["zh-CN"].translation, en = resources["en-US"].translation;
    expect(Object.keys(en).filter((key) => !/_(one|other)$/.test(key)).sort()).toEqual(Object.keys(zh).sort());
    const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(en[key], key).toBeTruthy();
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
    }
  });
  it("interpolates values without escaping text and handles English plurals", () => {
    expect(translate("en-US", "tool.files", { count: 1 })).toBe("1 file");
    expect(translate("en-US", "MessageQueueList.attachments", { count: 1, value1: 1 })).toBe("1 attachment");
    expect(translate("en-US", "tool.files", { count: 2 })).toBe("2 files");
    expect(translate("zh-CN", "tool.files", { count: 2 })).toBe("2 个文件");
    expect(translate("en-US", "tool.failed", { error: '<raw & "quoted">' })).toBe('Failed: <raw & "quoted">');
  });
  it("preserves raw errors, ignores unknown descriptors, and validates metadata", () => {
    const error = withMessage(new TypeError("密码错误"), "error.incorrect_password");
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("密码错误");
    expect(renderMessage("en-US", error)).toBe("Incorrect password");
    expect(renderMessage("zh-CN", error)).toBe("密码错误");
    expect(renderMessage("en-US", { message: "模型原文" })).toBe("模型原文");
    for (const value of [null, {}, { i18n: null }, { i18n: { key: "unknown" } }, { i18n: { key: "error.incorrect_password", params: [] } }, { i18n: { key: "error.incorrect_password", params: { bad: {} } } }]) expect(errorI18n(value)).toBeUndefined();
    expect(withMessage(new Error("raw"), "tool.failed", { error: true }).i18n.params).toEqual({ error: "true" });
  });
});

it("localizes only tool presentation and preserves untrusted raw values", () => {
  const input = { path: "中文文件.txt", old_text: "用户原文", new_text: "模型回复" };
  const zh = localizedToolFormatters("workspace_edit_file", "zh-CN")!;
  const en = localizedToolFormatters("workspace_edit_file", "en-US")!;
  expect(zh.formatArguments(input).detail).toContain("**替换前**");
  expect(en.formatArguments(input).detail).toContain("**Before**");
  expect(en.formatArguments(input).detail).toContain("用户原文");
  expect(en.formatResult({ input, output: '{"exitCode":0}', error: null }).summary).toBe("Exit code 0");
  expect(localizedToolFormatters("third_party_tool", "en-US")).toBeUndefined();
});

it("bounds localized tool output without splitting Unicode or executable Markdown fences", () => {
  const formatter = localizedToolFormatters("workspace_write_file", "en-US")!;
  const result = formatter.formatArguments({ path: "🦊".repeat(600), text: "```\n" + "中文".repeat(40_000) });
  expect(Array.from(result.summary!).length).toBeLessThanOrEqual(512);
  expect(result.summary).toContain("truncated");
  expect(new TextEncoder().encode(result.detail).length).toBeLessThanOrEqual(64 * 1024);
  expect(result.detail).not.toContain("\uFFFD");
  expect(result.detail).toContain("````");
});

it("shows English result counts and labels while preserving search and file payloads", () => {
  const result = (name: string, output: unknown) => localizedToolFormatters(name, "en-US")!.formatResult({ input: {}, output: JSON.stringify(output), error: null });
  const file = result("workspace_publish_file", { assets: [{ url: "/api/files/id", fileName: "用户文件" }] });
  expect(file.summary).toBe("1 file");
  expect(file.detail).toContain("[用户文件](/api/files/id)");
  expect(result("workspace_publish_file", {}).summary).toBe("0 files");
  const search = result("search_web", { results: [{ url: "https://example.com", snippet: "中文结果" }] });
  expect(search.detail).toContain("**Result**");
  expect(search.detail).toContain("中文结果");
  expect(result("workspace_list", []).detail).toBe("(empty list)");
  expect(result("workspace_list", Array.from({ length: 101 }, (_, i) => ({ nested: [i] }))).detail).toContain("1 more item");
});
