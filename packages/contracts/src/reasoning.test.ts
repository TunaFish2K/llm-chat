import { expect, it } from "vitest";
import { legacyReasoningSelection, modelCapabilitiesSchema, resolveModelReasoningSelection, type ReasoningSelection } from "./index";

const model = (values: string[] | null) => ({ capabilities: modelCapabilitiesSchema.parse({ reasoning: true }), detectedReasoningEfforts: values });

it.each([
  ["medium", ["low", "xhigh"], "xhigh"],
  ["low", ["high", "medium"], "medium"],
  ["max", ["xhigh", "high", "low"], "xhigh"],
  ["minimal", ["none", "low"], "low"],
  ["none", ["low", "high"], "low"],
  ["high", ["minimal", "high", "none", "default"], "high"],
  ["max", ["minimal", "high", "none", "default"], "high"],
  ["none", ["minimal", "none", "default"], "none"],
  ["default", ["minimal", "none", "default"], "default"],
  ["custom", ["custom", "other"], "custom"],
  ["old-custom", ["high", "low", "custom-top"], "custom-top"],
  ["medium", ["custom-bottom", "custom-top"], "custom-top"]
])("resolves %s against %j to %s without changing the request or order", (value, values, expected) => {
  const profile = model(values as string[]);
  const requested: ReasoningSelection = { mode: "effort", value: value as string };
  const before = structuredClone({ profile, requested });
  expect(resolveModelReasoningSelection(profile, requested)).toEqual({ mode: "effort", value: expected });
  expect({ profile, requested }).toEqual(before);
});

it("gives manual lists precedence, including an explicitly empty list", () => {
  const requested = { mode: "effort", value: "medium" } as const;
  expect(resolveModelReasoningSelection({ ...model(["medium"]), reasoningEffortsOverride: ["low", "high"] }, requested))
    .toEqual({ mode: "effort", value: "high" });
  expect(resolveModelReasoningSelection({ ...model(["medium"]), reasoningEffortsOverride: [] }, requested)).toEqual({ mode: "default" });
});

it("defaults unsupported, unavailable and unknown models without confusing native none with legacy none", () => {
  for (const profile of [undefined, model(null), model([]), { ...model(["high"]), capabilities: modelCapabilitiesSchema.parse({ reasoning: false }) }]) {
    expect(resolveModelReasoningSelection(profile, { mode: "effort", value: "high" })).toEqual({ mode: "default" });
  }
  expect(resolveModelReasoningSelection(model(["none"]), legacyReasoningSelection("none"))).toEqual({ mode: "default" });
  expect(resolveModelReasoningSelection(model(["none"]), { mode: "effort", value: "none" })).toEqual({ mode: "effort", value: "none" });
});
