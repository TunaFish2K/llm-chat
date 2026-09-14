import { describe, expect, it } from "vitest";
import { localizedToolFormatters } from "./tool-presentation";

for (const locale of ["zh-CN", "en-US"] as const) describe(locale, () => {
  const result = (name: string, value: unknown, error: string | null = null) => localizedToolFormatters(name, locale)!.formatResult({ input: { path: "file.py" }, output: value === undefined ? null : JSON.stringify(value), error });
  it("formats command input, file edits and mixed nested data without changing code", () => {
    expect(localizedToolFormatters("workspace_shell", locale)!.formatArguments({ command: "printf x", cwd: "." }).detail).toContain("```bash\nprintf x");
    expect(localizedToolFormatters("eval_javascript", locale)!.formatArguments({ code: "1 + 1" }).detail).toContain("```javascript\n1 + 1");
    expect(localizedToolFormatters("workspace_shell", locale)!.formatArguments({}).detail).toContain("```bash");
    expect(localizedToolFormatters("workspace_edit_file", locale)!.formatArguments({ path: "file.unknown", old_text: "x", new_text: "y" }).detail).toContain("\nx\n```");
    expect(localizedToolFormatters("workspace_write_file", locale)!.formatArguments({ path: 42 }).detail).toContain("```");
    const mixed = result("workspace_list", [{ nested: { a: { b: { c: { d: true } } } }, multiline: "one\ntwo" }, null, false, 0]);
    expect(mixed.detail).toContain("```json"); expect(mixed.detail).toContain("one\ntwo");
    expect(result("workspace_list", Array.from({ length: 101 }, (_, i) => `value-${i}`)).detail).not.toContain("value-100");
    expect(result("workspace_list", Array.from({ length: 101 }, (_, i) => ({ n: i, optional: i ? null : "*" }))).detail).toContain("| n | optional |");
    expect(result("workspace_list", [{ one: 1 }, { two: 2 }]).detail).toContain("| one | two |");
    expect(result("workspace_list", [{}, {}]).detail).toBeTruthy();
  });
  it("renders network and search payloads without making unsafe URL schemes clickable", () => {
    for (const name of ["fetch_url", "browser_fetch"]) {
      expect(result(name, { url: "https://example.com/a b", text: "page" }).detail).toContain("<https://example.com/a%20b>");
      expect(result(name, { url: "javascript:alert(1)", content: "fallback" }).detail).toContain("fallback");
      expect(result(name, {}).detail).not.toContain("javascript:");
    }
    const entries = [{ url: "javascript:alert(1)", text: "plain" }, { title: "Title", url: "https://example.com", content: "fallback" }, { snippet: "short" }, null];
    for (const shape of [entries, { results: entries }]) {
      const output = result("search_web", shape); expect(output.detail).toContain("fallback"); expect(output.detail).toContain("plain");
      expect(output.detail).not.toContain("<javascript:"); expect(output.detail).toContain("https://example.com");
    }
  });
  it("preserves file labels, optional results and explicit provider failures", () => {
    expect(result("workspace_publish_file", { asset: { url: "/api/files/a (b)" } }).detail).toContain("/api/files/a%20%28b%29");
    expect(result("image_generate", { assets: [null, { url: "file:///private", fileName: "external" }] }).detail).toContain("external");
    expect(result("workspace_read_file", { text: "print(1)" }).detail).toContain("```python\nprint(1)");
    expect(result("workspace_read_file", {}).detail).toContain("```python");
    expect(result("workspace_shell", { stdout: "hello", exitCode: 1 }, "bad *input*").summary).toContain("bad \\*input\\*");
    expect(result("workspace_shell", { stderr: "oops" }).detail).toContain("oops");
    expect(result("workspace_shell", { status: "stopped" }).summary).toBe("stopped");
    expect(result("workspace_list", { entries: [1, 2] }).summary).toContain("2");
    expect(result("image_generate", { assets: [] }, "failed").summary).toContain("failed");
    expect(result("get_time_info", undefined).detail).toContain("```");
  });
});
