import { describe, expect, it } from "vitest";
import { initialReasoningExpanded } from "./uiPreferences";

describe("reasoning collapse policy", () => {
  it("keeps always-collapsed closed", () => {
    expect(initialReasoningExpanded("always-collapsed", true, false)).toBe(false);
  });

  it("opens collapse-on-answer only while reasoning precedes the answer", () => {
    expect(initialReasoningExpanded("collapse-on-answer", true, false)).toBe(true);
    expect(initialReasoningExpanded("collapse-on-answer", true, true)).toBe(false);
    expect(initialReasoningExpanded("collapse-on-answer", false, true)).toBe(false);
  });

  it("opens never-auto-collapse regardless of generation status", () => {
    expect(initialReasoningExpanded("never-auto-collapse", false, true)).toBe(true);
  });
});
