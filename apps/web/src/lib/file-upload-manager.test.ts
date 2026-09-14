import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, type FileAssetDto, type FileUploadDto } from "@llm-chat/contracts";
import type { FileUploadHttp } from "./file-upload-http";
import type { hashFileInWorker } from "./file-hash-client";
import { FileUploadManager, uploadDelay } from "./file-upload-manager";
import { ApiRequestError } from "./http-client";
import { readComposerDraft, updateDraftAttachments, writeComposerDraft } from "./composer-draft-storage";

const asset: FileAssetDto = { id: "asset", kind: "file", fileName: "data.bin", mimeType: "application/octet-stream", byteSize: 10, sha256: "a".repeat(64), url: "/api/files/asset", createdAt: 1 };
const managers: FileUploadManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.reset(); });
function setup(storage = new Map<string, string>()) {
  let row: FileUploadDto;
  const http = {
    create: vi.fn<FileUploadHttp["create"]>(async (input) => row = { ...input, offset: 0, state: "uploading", expiresAt: Date.now() + 86_400_000, asset: null, error: null }),
    get: vi.fn<FileUploadHttp["get"]>(async () => ({ ...row })),
    append: vi.fn<FileUploadHttp["append"]>(async (_id, offset, blob: Blob) => row = { ...row, offset: offset + blob.size }),
    complete: vi.fn<FileUploadHttp["complete"]>(async () => row = { ...row, state: "completed", asset }),
    cancel: vi.fn<FileUploadHttp["cancel"]>(async () => {})
  };
  const hash = vi.fn<typeof hashFileInWorker>(async (_file, _signal, progress) => { progress(10); return "a".repeat(64); });
  const attach = vi.fn(); const changed = vi.fn(); const delay = vi.fn(async (_ms, signal: AbortSignal) => { signal.throwIfAborted(); });
  const online = vi.fn(() => true);
  const image = vi.fn<(file: File) => Promise<FileAssetDto>>(async () => ({ ...asset, kind: "image" as const }));
  const manager = new FileUploadManager({ http, hash, attach, changed, image, delay, online,
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } } });
  managers.push(manager);
  const scope = manager.ensure("conversation:a", [], "a");
  const file = new File(["0123456789"], "data.bin");
  return { manager, scope, file, http, hash, attach, changed, delay, online, image, storage, get row() { return row; }, set row(value) { row = value; } };
}

describe("upload queue", () => {
  it("uploads in bounded chunks and merges into the originating draft after navigation", async () => {
    const x = setup(); const file = new File([new Uint8Array(FILE_UPLOAD_CHUNK_BYTES + 1)], "big.bin");
    x.manager.enqueue(x.scope.id, [file]);
    x.manager.ensure("conversation:b", [], "b");
    x.manager.setAttachments(x.scope.id, [{ ...asset, id: "existing" }]);
    await vi.waitFor(() => expect(x.scope.tasks).toHaveLength(0));
    expect(x.http.append.mock.calls.map((call) => [call[1], call[2].size])).toEqual([[0, FILE_UPLOAD_CHUNK_BYTES], [FILE_UPLOAD_CHUNK_BYTES, 1]]);
    expect(x.attach).toHaveBeenLastCalledWith(x.scope.id, [expect.objectContaining({ id: "existing" }), asset]);
    expect(x.manager.ensure("conversation:b", []).attachments).toEqual([]);
  });

  it("queries the acknowledged offset before retrying a lost chunk response", async () => {
    const x = setup();
    x.http.append.mockImplementationOnce(async (_id, offset, blob) => {
      x.row = { ...x.row, offset: offset + blob.size };
      throw new ApiRequestError(0, "network_error", "disconnected");
    });
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.attachments).toEqual([asset]));
    expect(x.http.append).toHaveBeenCalledTimes(1);
    expect(x.delay).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
  });

  it("restores metadata without file contents and rejects a different reselected file", async () => {
    const x = setup(); x.http.append.mockRejectedValue(new ApiRequestError(507, "disk_full", "disk full"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const saved = [...x.storage.values()][0]!;
    expect(saved).not.toContain('"file":'); expect(saved).not.toContain('"controller":');
    const y = setup(x.storage); y.row = x.row;
    const restored = y.manager.ensure(x.scope.id, []);
    expect(restored.tasks[0]?.status).toBe("needs-file");
    y.manager.setSource("local");
    await vi.waitFor(() => expect(restored.tasks[0]?.status).toBe("needs-file"));
    expect(y.http.append).not.toHaveBeenCalled();
    y.hash.mockResolvedValueOnce("b".repeat(64));
    y.manager.retry(restored.id, restored.tasks[0]!.id, x.file);
    await vi.waitFor(() => expect(restored.tasks[0]?.error).toContain("不一致"));
    expect(y.http.append).not.toHaveBeenCalled();
    y.manager.retry(restored.id, restored.tasks[0]!.id, x.file);
    await vi.waitFor(() => expect(restored.attachments).toEqual([asset]));
  });

  it("finds a completed upload after refresh without requiring the file again", async () => {
    const x = setup(); x.http.complete.mockRejectedValue(new ApiRequestError(0, "network_error", "lost"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const y = setup(x.storage); y.row = { ...x.row, state: "completed", asset }; y.manager.setSource("local");
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.hash).not.toHaveBeenCalled();
  });

  it("cancels tasks, drops late image results, and clears old scopes on logout or source change", async () => {
    const x = setup(); let finish!: (value: FileAssetDto) => void;
    x.image.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    x.manager.enqueue(x.scope.id, [new File(["image"], "p.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(x.image).toHaveBeenCalled());
    x.manager.cancel(x.scope.id, x.scope.tasks[0]!.id); finish(asset);
    await vi.waitFor(() => expect(x.scope.tasks).toHaveLength(0));
    expect(x.scope.attachments).toEqual([]);
    x.manager.setSource("different-instance"); expect(x.manager.all()).toEqual([]);
    x.manager.ensure("conversation:b", [], "b"); x.manager.removeConversation("b"); expect(x.manager.all()).toEqual([]);
    x.manager.reset(); expect(x.storage.size).toBe(0);
  });

  it("reserves slots and bytes for queued uploads before accepting another batch", () => {
    const x = setup(); x.hash.mockImplementation(() => new Promise(() => {}));
    const big = new File(["x"], "big.bin"); Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_FILE_BYTES });
    expect(x.manager.enqueue(x.scope.id, [big, big, x.file])).toEqual([expect.stringContaining("4 GiB")]);
    const other = x.manager.ensure("other", []);
    expect(x.manager.enqueue(other.id, Array(9).fill(x.file))).toEqual([expect.stringContaining("8")]);
    const images = x.manager.ensure("images", []);
    const png = new File(["image"], "p.png", { type: "image/png" });
    expect(x.manager.enqueue(images.id, Array(5).fill(png))).toEqual([expect.stringContaining("4")]);
    const invalid = x.manager.ensure("invalid", []);
    expect(x.manager.enqueue(invalid.id, [new File([], "empty")])).toHaveLength(1);
  });

  it("recovers an offset conflict and polls asynchronous server verification", async () => {
    const x = setup();
    x.http.append.mockRejectedValueOnce(new ApiRequestError(409, "conflict", "offset changed"));
    x.http.complete.mockImplementation(async () => x.row = { ...x.row, state: "checking" });
    x.http.get.mockImplementation(async () => {
      if (x.row.state === "checking") x.row = { ...x.row, state: "completed", asset };
      return { ...x.row };
    });
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.attachments).toEqual([asset]));
    expect(x.http.append).toHaveBeenCalledTimes(2);
    expect(x.delay).toHaveBeenCalledWith(500, expect.any(AbortSignal));
  });

  it("preserves newly edited text when updating background attachment references", () => {
    const draft = { text: "new text", attachments: [], agentId: null, overrides: {}, workspace: null, greetingIndex: 0, uploadScopeId: "draft:one" };
    writeComposerDraft(null, draft);
    updateDraftAttachments("draft:two", [asset]); expect(readComposerDraft(null)?.attachments).toEqual([]);
    updateDraftAttachments("draft:one", [asset]); expect(readComposerDraft(null)).toMatchObject({ text: "new text", attachments: [asset] });
  });

  it("allows aborting a retry delay", async () => {
    const controller = new AbortController(); const wait = uploadDelay(60_000, controller.signal);
    controller.abort(); await expect(wait).rejects.toThrow();
    await expect(uploadDelay(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});

it("waits for connectivity and honors throttling without duplicating a completed asset", async () => {
  const x = setup();
  x.online.mockReturnValueOnce(false);
  x.http.create.mockRejectedValueOnce(new ApiRequestError(429, "rate_limited", "slow down"));
  x.manager.setAttachments(x.scope.id, [asset]);
  x.manager.enqueue(x.scope.id, [x.file]);
  await vi.waitFor(() => expect(x.scope.tasks).toHaveLength(0));
  expect(x.delay).toHaveBeenCalledTimes(2);
  expect(x.http.create).toHaveBeenCalledTimes(2);
  expect(x.scope.attachments).toEqual([asset]);
  x.manager.reset();
  expect(x.manager.enqueue(x.scope.id, [x.file])).toHaveLength(1);
});

it("rechecks image quotas when an ordinary upload is identified as an image", async () => {
  const x = setup();
  x.manager.setAttachments(x.scope.id, Array.from({ length: 4 }, (_, i) => ({ ...asset, id: `image-${i}`, kind: "image" })));
  x.http.complete.mockImplementation(async () => x.row = { ...x.row, state: "completed", asset: { ...asset, kind: "image" } });
  x.manager.enqueue(x.scope.id, [x.file]);
  await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
  expect(x.scope.tasks[0]!.error).toContain("4");
  expect(x.scope.attachments).toHaveLength(4);
  x.manager.cancel(x.scope.id, x.scope.tasks[0]!.id);
  expect(x.http.cancel).toHaveBeenCalledTimes(1);
  x.manager.cancel("missing", "missing");
  x.manager.retry("missing", "missing");
});

it("resumes server verification after disk recovery without hashing or uploading again", async () => {
  const x = setup();
  x.http.complete.mockImplementation(async () => x.row = { ...x.row, state: "failed", error: "disk_full" });
  x.manager.enqueue(x.scope.id, [x.file]);
  await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
  const y = setup(x.storage);
  y.row = x.row;
  y.manager.setSource("local");
  await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
  expect(y.http.complete).toHaveBeenCalledTimes(1);
  expect(y.hash).not.toHaveBeenCalled();
  expect(y.http.append).not.toHaveBeenCalled();
});

it("surfaces terminal server errors after refresh instead of retrying their bytes", async () => {
  const x = setup();
  x.http.complete.mockImplementation(async () => x.row = { ...x.row, state: "failed", error: "hash_mismatch" });
  x.manager.enqueue(x.scope.id, [x.file]);
  await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
  const y = setup(x.storage); y.row = x.row;
  y.manager.setSource("local");
  await vi.waitFor(() => expect(y.scope.tasks[0]?.status).toBe("failed"));
  expect(y.scope.tasks[0]!.error).toBeTruthy();
  expect(y.http.append).not.toHaveBeenCalled();
  expect(y.http.complete).not.toHaveBeenCalled();
});

it("ignores damaged upload metadata and rejects oversized images before reading them", () => {
  for (const value of ["{", JSON.stringify({ sourceId: "local", scopes: [{ id: 3 }, { id: "bad", tasks: [], attachments: null }] })]) {
    const x = setup(new Map([["llm-chat.uploads.v1", value]]));
    expect(x.manager.all()).toHaveLength(1);
    const large = new File(["image"], "too-big.png", { type: "image/png" });
    Object.defineProperty(large, "size", { value: 5 * 1024 ** 2 + 1 });
    expect(x.manager.enqueue(x.scope.id, [large])).toHaveLength(1);
    expect(x.image).not.toHaveBeenCalled();
  }
});
