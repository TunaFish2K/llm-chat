import { describe, expect, it } from "vitest";
import { applySafeRegex, validateSafeRegex } from "./safe-regex";

describe("safe roleplay regex", () => {
  it("uses RE2-compatible replacements and rejects unsupported backreferences", () => {
    const script = {
      id: "strip", name: "strip", enabled: true, pattern: "secret\\s+", replacement: "",
      flags: "gi", scopes: ["user_prompt" as const], runOnEdit: false, importWarning: null
    };
    expect(applySafeRegex("SECRET value", [script], ["strip"], "user_prompt")).toBe("value");
    expect(validateSafeRegex("(a+)\\1", "g")).toMatch(/invalid|escape|backreference/i);
  });

  it("runs only explicitly enabled scopes, normalizes flags, and caps output", () => {
    const scripts = [
      { id: "disabled", name: "disabled", enabled: false, pattern: "value", replacement: "bad", flags: "", scopes: ["display" as const], runOnEdit: false, importWarning: null },
      { id: "not-selected", name: "not selected", enabled: true, pattern: "value", replacement: "bad", flags: "", scopes: ["display" as const], runOnEdit: false, importWarning: null },
      { id: "wrong-scope", name: "wrong scope", enabled: true, pattern: "value", replacement: "bad", flags: "", scopes: ["assistant_prompt" as const], runOnEdit: false, importWarning: null },
      { id: "selected", name: "selected", enabled: true, pattern: "VALUE", replacement: "ok", flags: "ig!!", scopes: ["display" as const], runOnEdit: false, importWarning: null }
    ];
    expect(applySafeRegex("value", scripts, ["disabled", "wrong-scope", "selected"], "display")).toBe("ok");
    const expanding = [{ ...scripts[3]!, pattern: "x+", replacement: "y".repeat(2_000_001), flags: "gu" }];
    expect(applySafeRegex("xxx", expanding, ["selected"], "display")).toHaveLength(2_000_000);
    expect(validateSafeRegex("a".repeat(20_001), "g")).toContain("过长");
    expect(validateSafeRegex("value", "gu")).toBeNull();
  });
});
