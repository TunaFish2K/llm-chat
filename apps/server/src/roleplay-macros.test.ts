import { describe, expect, it } from "vitest";
import { renderRoleplayMacros } from "./roleplay-macros";

describe("roleplay macros", () => {
  it("renders names, variables and deterministic random values", () => {
    const context = { character: "伊蕾娜", user: "旅人", variables: { place: "王都" }, seed: "turn-7", now: 0 };
    const source = "{{char}}/{{user}} @ {{var::place}}: {{random:甲::乙::丙}} d{{roll:20}} {{unknown}}";
    const first = renderRoleplayMacros(source, context);
    expect(first).toContain("伊蕾娜/旅人 @ 王都:");
    expect(first).toContain("{{unknown}}");
    expect(renderRoleplayMacros(source, context)).toBe(first);
  });
});
