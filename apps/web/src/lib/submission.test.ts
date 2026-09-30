import { expect, it, vi } from "vitest";
import { clearSubmissions, readSubmission, saveSubmission, setSubmissionSource, type Submission } from "./submission";

const attempt: Submission = { id: crypto.randomUUID(), kind: "send", text: "prepared", originalText: "draft", assetIds: ["asset"], mode: "queue", prepared: true,
  input: { agentId: "agent", greetingIndex: 0, executionOverrides: {}, workspacePath: null } };

it("restores the frozen request and clears it on acceptance or a source change", () => {
  setSubmissionSource("first"); saveSubmission("conversation", attempt); saveSubmission(null, { ...attempt, kind: "start" });
  setSubmissionSource("first");
  expect(readSubmission("conversation")).toEqual(attempt);
  expect(readSubmission(null)?.kind).toBe("start");
  saveSubmission("conversation", null); expect(readSubmission("conversation")).toBeNull();
  setSubmissionSource("second"); expect(readSubmission(null)).toBeNull();
});

it("ignores corrupt stored receipts", () => {
  for (const value of ["{", "null", JSON.stringify({ id: "missing fields", text: "" }), JSON.stringify({ ...attempt, assetIds: [3] })]) {
    sessionStorage.setItem("llm-chat.submission.v1.corrupt", value);
    expect(readSubmission("corrupt")).toBeNull();
  }
});

it("keeps manual retry available in memory if browser storage fails", () => {
  vi.spyOn(sessionStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  setSubmissionSource("private"); saveSubmission(null, attempt);
  expect(readSubmission(null)).toEqual(attempt);
  clearSubmissions(); expect(readSubmission(null)).toBeNull();
});
