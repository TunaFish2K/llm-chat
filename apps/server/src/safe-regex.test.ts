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
});
