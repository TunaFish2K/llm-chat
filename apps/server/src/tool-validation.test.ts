import { describe, expect, it } from "vitest";
import { ToolValidatorCache, validateToolInput } from "./tool-validation";

describe("bounded tool validators", () => {
  it("reuses equivalent schemas across fresh tool instances and evicts whole compilers", () => {
    const cache = new ToolValidatorCache();
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const first = cache.get(schema);
    for (let i = 0; i < 1000; i++) expect(cache.get(structuredClone(schema))).toBe(first);
    expect(cache.size).toBe(1);
    for (let i = 0; i < 200; i++) cache.get({ type: "object", properties: { [String(i)]: { type: "number" } } });
    expect(cache.size).toBe(128);
    expect(cache.get(schema)).not.toBe(first);
    expect(first({ value: "still valid for an active caller" })).toBe(true);
    expect(first({ value: 5 })).toBe(false);
  });
  it("keeps local refs, validation errors and independent schemas with the same id", () => {
    const cache = new ToolValidatorCache();
    const a = cache.get({ $id: "urn:example:tool", type: "object", $defs: { item: { type: "string" } }, properties: { x: { $ref: "#/$defs/item" } } });
    const b = cache.get({ $id: "urn:example:tool", type: "number" });
    expect(a({ x: 42 })).toBe(false); expect(a({ x: "ok" })).toBe(true); expect(b(42)).toBe(true);
    expect(() => validateToolInput("probe", { type: "object", required: ["value"] }, {})).toThrow(/Invalid tool arguments for probe.*value/);
  });
});
