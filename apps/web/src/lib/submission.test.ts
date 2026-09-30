import { expect, it, vi } from "vitest";
import { clearSubmissions, readSubmission, recordSubmissionAcceptance, saveSubmission, setSubmissionSource, waitForSubmission, type Submission } from "./submission";
import { makeConversation } from "../../test/fixtures";

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

it("uses the first notification and ignores a late HTTP error", async () => {
  let reject!: (error: Error) => void;
  const result = { generationId: "generation", assistantMessageId: "assistant" };
  const receipt = { clientSubmissionId: attempt.id, kind: "send" as const, sourceId: "source", conversation: makeConversation(), messages: [], result };
  let requestSignal!: AbortSignal;
  const write = waitForSubmission(attempt.id, signal => {
    requestSignal = signal;
    return new Promise<typeof result>((_, failed) => { reject = failed; });
  });
  expect(recordSubmissionAcceptance(receipt)).toBe(true);
  expect(recordSubmissionAcceptance(receipt)).toBe(false);
  await expect(write).resolves.toMatchObject({ ...result, acceptance: receipt });
  expect(requestSignal.aborted).toBe(true);
  reject(new Error("response lost"));
  await Promise.resolve();
  const request = vi.fn();
  await expect(waitForSubmission(attempt.id, request)).resolves.toMatchObject(result);
  expect(request).not.toHaveBeenCalled();
});

it("returns HTTP confirmation or failure and releases its listener", async () => {
  await expect(waitForSubmission("http-first", async () => ({ accepted: true }))).resolves.toEqual({ accepted: true });
  await expect(waitForSubmission("failure", async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
});
