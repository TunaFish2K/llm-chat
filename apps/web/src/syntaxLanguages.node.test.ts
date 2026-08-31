import { describe, expect, it } from "vitest";
import { loadSyntaxLanguage, normalizeSyntaxLanguage, syntaxLanguages } from "./syntaxLanguages";

describe("syntax language registry", () => {
  it("normalizes aliases, parameters, casing, and unsupported names", () => {
    expect(normalizeSyntaxLanguage(" TS extra ")).toBe("typescript");
    expect(normalizeSyntaxLanguage("c++")).toBe("cpp");
    expect(normalizeSyntaxLanguage("not-a-language")).toBeUndefined();
    expect(normalizeSyntaxLanguage()).toBeUndefined();
  });

  it("loads every supported grammar once and reuses pending and loaded entries", async () => {
    const first = loadSyntaxLanguage("bash");
    expect(loadSyntaxLanguage("bash")).toBe(first);
    await Promise.all([first, ...syntaxLanguages.filter((language) => language !== "bash").map(loadSyntaxLanguage)]);
    await expect(loadSyntaxLanguage("bash")).resolves.toBeUndefined();
  });
});
