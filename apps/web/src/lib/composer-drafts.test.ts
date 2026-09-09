import { describe, expect, it, vi } from "vitest";
import { endpoints } from "./api";
import { flushServerDraft, readComposerDraft, scheduleServerDraft, serializeModelSelection, writeComposerDraft, type ComposerDraft } from "./composer-drafts";
import { makeConversation } from "../../test/fixtures";

const draft: ComposerDraft = { text: "未发送", attachments: [], agentId: "agent", overrides: { modelId: "model" }, workspace: "/tmp", greetingIndex: 2 };

describe("tab drafts", () => {
  it("restores independent new and branch drafts, including an explicit empty draft", () => {
    expect(readComposerDraft(null)).toBeNull();
    writeComposerDraft(null, draft);
    writeComposerDraft("branch", { ...draft, text: "分支" });
    expect(readComposerDraft(null)).toEqual(draft);
    expect(readComposerDraft("branch")?.text).toBe("分支");
    writeComposerDraft("branch", { ...draft, text: "", attachments: [] });
    expect(readComposerDraft("branch")?.text).toBe("");
    expect(readComposerDraft("other")).toBeNull();
  });

  it("discards corrupt data and filters incomplete attachment records", () => {
    for (const value of ["invalid", "null", JSON.stringify({ ...draft, text: 42 }), JSON.stringify({ ...draft, overrides: { modelId: 4 } }),
      JSON.stringify({ ...draft, attachments: null }), JSON.stringify({ ...draft, agentId: 4 }),
      JSON.stringify({ ...draft, workspace: 4 }), JSON.stringify({ ...draft, greetingIndex: -1 })]) {
      window.sessionStorage.setItem("llm-chat.composer.v1.bad", value);
      expect(readComposerDraft("bad")).toBeNull();
    }
    const asset = { id: "file", url: "/api/files/file", fileName: "note.txt", mimeType: "text/plain", byteSize: 1, kind: "file", sha256: "hash", createdAt: 1 };
    window.sessionStorage.setItem("llm-chat.composer.v1.assets", JSON.stringify({ ...draft, agentId: null, workspace: null, attachments: [null, {}, asset] }));
    expect(readComposerDraft("assets")?.attachments).toEqual([asset]);
  });

  it("keeps an in-memory copy and warns once when storage is unavailable", () => {
    const warning = vi.fn();
    window.addEventListener("llm-chat:draft-storage-unavailable", warning);
    const write = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    writeComposerDraft("fallback", draft);
    writeComposerDraft("fallback", { ...draft, text: "最新" });
    expect(readComposerDraft("fallback")?.text).toBe("最新");
    expect(warning).toHaveBeenCalledTimes(1);
    const read = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readComposerDraft("fallback")?.text).toBe("最新");
    read.mockRestore(); write.mockRestore();
    writeComposerDraft("fallback", draft);
    expect(readComposerDraft("fallback")).toEqual(draft);
    window.removeEventListener("llm-chat:draft-storage-unavailable", warning);
  });
});

describe("server draft ordering", () => {
  it("coalesces typing, waits for in-flight writes, then clears in order", async () => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => { finish = resolve; });
    const update = vi.spyOn(endpoints, "updateConversation")
      .mockImplementationOnce(async () => { await first; return makeConversation(); })
      .mockResolvedValue(makeConversation());
    scheduleServerDraft("order", "old");
    scheduleServerDraft("order", "latest");
    const flushing = flushServerDraft("order");
    await Promise.resolve(); await Promise.resolve();
    expect(update).toHaveBeenCalledWith("order", { draft: "latest" });
    scheduleServerDraft("order", "");
    const clearing = flushServerDraft("order");
    expect(update).toHaveBeenCalledTimes(1);
    finish(); await flushing; await clearing;
    expect(update.mock.calls.map((call) => call[1])).toEqual([{ draft: "latest" }, { draft: "" }]);
    await flushServerDraft("order");
  });

  it("flushes after typing pauses and recovers from a failed write", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.spyOn(endpoints, "updateConversation").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(makeConversation());
      scheduleServerDraft("retry", "draft");
      await vi.advanceTimersByTimeAsync(500);
      expect(update).toHaveBeenCalledTimes(1);
      scheduleServerDraft("retry", "retry");
      await flushServerDraft("retry");
      expect(update).toHaveBeenLastCalledWith("retry", { draft: "retry" });
    } finally { vi.useRealTimers(); }
  });

  it("serializes selections per Agent without blocking other Agents or later retries", async () => {
    let fail!: (reason: Error) => void;
    const first = serializeModelSelection("a", () => new Promise<void>((_, reject) => { fail = reject; }));
    const failed = expect(first).rejects.toThrow("offline");
    const second = vi.fn(async () => "second");
    const next = serializeModelSelection("a", second);
    expect(await serializeModelSelection("b", async () => "independent")).toBe("independent");
    expect(second).not.toHaveBeenCalled();
    fail(new Error("offline")); await failed;
    expect(await next).toBe("second");
    expect(await serializeModelSelection("a", async () => "third")).toBe("third");
  });
});
