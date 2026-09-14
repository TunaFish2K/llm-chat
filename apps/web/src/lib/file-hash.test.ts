import { Blob as NodeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FILE_UPLOAD_CHUNK_BYTES } from "@llm-chat/contracts";
import { hashFile } from "./file-hash";
import { hashFileInWorker } from "./file-hash-client";

describe("file hashing", () => {
  it("hashes slices incrementally and reports progress", async () => {
    const bytes = Buffer.alloc(FILE_UPLOAD_CHUNK_BYTES + 9, 123);
    const file = new NodeBlob([bytes]); const slice = vi.spyOn(file, "slice"); const progress = vi.fn();
    expect(await hashFile(file as unknown as Blob, progress)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(slice.mock.calls.map((call) => call[0])).toEqual([0, FILE_UPLOAD_CHUNK_BYTES]);
    expect(progress.mock.calls.map((call) => call[0])).toEqual([FILE_UPLOAD_CHUNK_BYTES, bytes.length]);
    expect(await hashFile(new NodeBlob([]) as unknown as Blob, progress)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("terminates the worker on completion, cancellation, and read errors", async () => {
    let worker: FakeWorker;
    class FakeWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: () => void;
      terminate = vi.fn(); postMessage = vi.fn();
      constructor() { worker = this; }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const file = new File(["abc"], "test"); const progress = vi.fn();
    const ready = hashFileInWorker(file, new AbortController().signal, progress);
    worker!.onmessage?.({ data: { bytes: 3 } }); worker!.onmessage?.({ data: { sha256: "abc" } });
    await expect(ready).resolves.toBe("abc"); expect(progress).toHaveBeenCalledWith(3); expect(worker!.terminate).toHaveBeenCalledOnce();
    const controller = new AbortController(); const stopped = hashFileInWorker(file, controller.signal, progress); controller.abort();
    await expect(stopped).rejects.toThrow(); expect(worker!.terminate).toHaveBeenCalledOnce();
    for (const error of ["read", "worker"]) {
      const failed = hashFileInWorker(file, new AbortController().signal, progress);
      if (error === "read") worker!.onmessage?.({ data: { error: true } }); else worker!.onerror?.();
      await expect(failed).rejects.toThrow("读取文件"); expect(worker!.terminate).toHaveBeenCalledOnce();
    }
  });
});
