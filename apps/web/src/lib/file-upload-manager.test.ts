import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRequestRetries } from "./request-preferences";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, type FileAssetDto, type FileUploadDto } from "@llm-chat/contracts";
import type { FileUploadHttp } from "./file-upload-http";
import type { hashFileInWorker } from "./file-hash-client";
import { FileUploadManager, uploadDelay } from "./file-upload-manager";
import { ApiRequestError } from "./http-client";
import { readComposerDraft, updateDraftAttachments, writeComposerDraft } from "./composer-draft-storage";
import { File as NodeFile, Blob as NodeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { FileUploadDatabase, type UploadPersistence } from "./file-upload-db";

const asset: FileAssetDto = { id: "asset", kind: "file", fileName: "data.bin", mimeType: "application/octet-stream", byteSize: 10, sha256: "a".repeat(64), url: "/api/files/asset", createdAt: 1 };
const managers: FileUploadManager[] = [];
beforeEach(() => saveRequestRetries(2));
afterEach(() => { for (const manager of managers.splice(0)) manager.reset(); });
function setup(storage = new Map<string, string>(), persistence?: UploadPersistence) {
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
  const imageLimits = vi.fn(() => ({ image: 5 * 1024 ** 2, message: 20 * 1024 ** 2 }));
  const manager = new FileUploadManager({ http, hash, attach, changed, imageLimits, delay, online, ...(persistence ? { persistence } : {}),
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } } });
  managers.push(manager);
  const scope = manager.ensure("conversation:a", [], "a");
  const file = new File(["0123456789"], "data.bin");
  return { manager, scope, file, http, hash, attach, changed, delay, online, imageLimits, storage, get row() { return row; }, set row(value) { row = value; } };
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
    expect(x.delay).toHaveBeenCalledWith(expect.any(Number), expect.any(AbortSignal));
    expect(x.delay.mock.calls[0]![0]).toBeGreaterThanOrEqual(400);
    expect(x.delay.mock.calls[0]![0]).toBeLessThanOrEqual(600);
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
    const x = setup(); let finish!: (value: FileUploadDto) => void;
    x.http.complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    x.manager.enqueue(x.scope.id, [new File(["image"], "p.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(x.http.complete).toHaveBeenCalled());
    x.manager.cancel(x.scope.id, x.scope.tasks[0]!.id); finish({ ...x.row, state: "completed", asset: { ...asset, kind: "image" } });
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
    expect(x.delay).toHaveBeenCalledWith(100, expect.any(AbortSignal));
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

it("attempts uploads despite offline telemetry and retries throttling without duplicating an asset", async () => {
  const x = setup();
  x.online.mockReturnValue(false);
  x.http.create.mockRejectedValueOnce(new ApiRequestError(429, "rate_limited", "slow down"));
  x.manager.setAttachments(x.scope.id, [asset]);
  x.manager.enqueue(x.scope.id, [x.file]);
  await vi.waitFor(() => expect(x.scope.tasks).toHaveLength(0));
  expect(x.delay).toHaveBeenCalledTimes(1);
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
    expect(x.manager.enqueue(x.scope.id, [large])).toEqual([expect.stringContaining("5.0 MiB")]);
    expect(x.hash).not.toHaveBeenCalled();
  }
});

it("keeps the chosen kind: files skip image limits and images use the configured limit", async () => {
  const x = setup();
  const photo = new File(["image"], "photo.png", { type: "image/png" });
  Object.defineProperty(photo, "size", { value: 50 * 1024 ** 2 });
  expect(x.manager.enqueue(x.scope.id, [photo], "image")).toEqual([expect.stringContaining("5.0 MiB")]);
  expect(x.manager.enqueue(x.scope.id, [new File(["%PDF"], "doc.pdf", { type: "application/pdf" })], "image")).toEqual([expect.any(String)]);
  x.imageLimits.mockReturnValue({ image: 100 * 1024 ** 2, message: 400 * 1024 ** 2 });
  const small = new File(["0123456789"], "small.png", { type: "image/png" });
  expect(x.manager.enqueue(x.scope.id, [small], "file")).toEqual([]);
  await vi.waitFor(() => expect(x.http.create).toHaveBeenCalledWith(expect.objectContaining({ fileName: "small.png", kind: "file" }), expect.anything()));
  const other = x.manager.ensure("other", []);
  expect(x.manager.enqueue(other.id, [small])).toEqual([]);
  await vi.waitFor(() => expect(x.http.create).toHaveBeenCalledWith(expect.objectContaining({ kind: "image" }), expect.anything()));
});

describe("persistent upload queue", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("File", NodeFile); vi.stubGlobal("Blob", NodeBlob);
    saveRequestRetries(0);
  });

  it("retains files selected during bootstrap and starts after the source is confirmed", async () => {
    const x = setup(new Map(), new FileUploadDatabase());
    x.manager.enqueue(x.scope.id, [x.file]);
    expect(x.http.create).not.toHaveBeenCalled();
    x.manager.setSource("confirmed-server"); await x.manager.ready();
    await vi.waitFor(() => expect(x.scope.attachments).toEqual([asset]));
  });

  it("saves bytes before its first request and restores after closing without sessionStorage", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    x.http.create.mockImplementationOnce(async () => {
      const rows = await (await db.open("local")).list();
      expect(rows[0]?.cached).toBe(true);
      throw new ApiRequestError(0, "network_error", "offline");
    });
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    expect(x.scope.tasks[0]?.file).toBe(x.file);
    const y = setup(new Map(), db); y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.http.append).toHaveBeenCalledTimes(1);
    expect(await (await db.open("local")).list()).toEqual([]);
  });

  it("retries a failed upload without selecting a file and resumes from the acknowledged offset", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    const file = new File([new Uint8Array(FILE_UPLOAD_CHUNK_BYTES + 1)], "chunks.bin");
    x.http.append.mockImplementationOnce(async (_id, offset, blob) => x.row = { ...x.row, offset: offset + blob.size });
    x.http.append.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const y = setup(new Map(), db); y.row = x.row; y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.http.append.mock.calls.map((call) => [call[1], call[2].size])).toEqual([[FILE_UPLOAD_CHUNK_BYTES, 1]]);
    expect(y.http.create).not.toHaveBeenCalled();
  });

  it("uses a fresh server ID when a cached upload receipt has expired", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    x.http.append.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const oldId = x.scope.tasks[0]!.id;
    const y = setup(new Map(), db); y.http.get.mockRejectedValueOnce(new ApiRequestError(404, "expired", "expired"));
    y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.http.create.mock.calls[0]![0].id).not.toBe(oldId);
  });

  it("recovers completed remote uploads without uploading their bytes again", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    x.http.complete.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "lost response"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const y = setup(new Map(), db); y.row = { ...x.row, state: "completed", asset };
    y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.http.append).not.toHaveBeenCalled(); expect(y.hash).not.toHaveBeenCalled();
  });

  it("continues uploading when saving the Blob fails and keeps a visible warning", async () => {
    const db = new FileUploadDatabase(); const session = await db.open("local");
    const save = session.put.bind(session);
    const put = vi.spyOn(session, "put").mockImplementation((scope, task, file) => file
      ? Promise.reject(new DOMException("full", "QuotaExceededError")) : save(scope, task));
    const x = setup(new Map(), { open: async () => session }); x.manager.setSource("local"); await x.manager.ready();
    x.http.create.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    expect(x.scope.tasks[0]?.cacheWarning).toBe(true);
    expect(x.scope.tasks[0]?.file).toBe(x.file); expect(put).toHaveBeenCalled();
    x.manager.retry(x.scope.id, x.scope.tasks[0]!.id);
    await vi.waitFor(() => expect(x.scope.attachments).toEqual([asset]));
  });

  it("imports old receipts and requests the original only when no cached bytes exist", async () => {
    const x = setup(); x.http.append.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const db = new FileUploadDatabase(); const y = setup(x.storage, db); y.row = x.row;
    y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.tasks[0]?.status).toBe("needs-file"));
    y.manager.retry(y.scope.id, y.scope.tasks[0]!.id, x.file);
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
  });

  it("finishes server verification without the original once all bytes are acknowledged", async () => {
    const x = setup(); x.http.complete.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "lost response"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const y = setup(x.storage, new FileUploadDatabase()); y.row = x.row;
    y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(y.hash).not.toHaveBeenCalled(); expect(y.http.append).not.toHaveBeenCalled();
    expect(y.http.complete).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a cancelled task when its pending Blob save finishes", async () => {
    const db = new FileUploadDatabase(); const session = await db.open("local");
    const x = setup(new Map(), { open: async () => session }); x.manager.setSource("local"); await x.manager.ready();
    const put = session.put.bind(session); let release!: () => void;
    const remove = vi.spyOn(session, "remove");
    vi.spyOn(session, "put").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; }); return put(...args);
    });
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    x.manager.cancel(x.scope.id, x.scope.tasks[0]!.id); release();
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    expect(await session.list()).toEqual([]);
    expect(x.http.create).not.toHaveBeenCalled(); expect(x.scope.tasks).toEqual([]);
  });

  it("keeps cached originals when a manually reselected file has a different hash", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    x.http.append.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    x.hash.mockResolvedValueOnce("b".repeat(64));
    x.manager.retry(x.scope.id, x.scope.tasks[0]!.id, new File(["wrong-file"], "wrong.bin"));
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("needs-file"));
    const y = setup(new Map(), db); y.row = x.row; y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.attachments).toEqual([asset]));
    expect(await y.http.append.mock.calls[0]![2].text()).toBe("0123456789");
  });

  it("caches all queued files while the two upload slots are occupied", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    x.hash.mockImplementation((_file, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    x.manager.enqueue(x.scope.id, Array.from({ length: 4 }, (_, i) => new File(["queued"], `queued-${i}.txt`)));
    const session = await db.open("local");
    await vi.waitFor(async () => expect((await session.list()).filter((row) => row.cached)).toHaveLength(4));
    await vi.waitFor(() => expect(x.hash).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(x.scope.tasks.filter((task) => task.status === "queued")).toHaveLength(2));
    x.manager.suspend();
  });

  it("keeps receipts but skips caching bytes above 64 MiB", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    Object.defineProperty(x.file, "size", { value: 65 * 1024 ** 2 });
    x.http.create.mockRejectedValueOnce(new ApiRequestError(0, "network_error", "offline"));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.scope.tasks[0]?.status).toBe("failed"));
    const rows = await (await db.open("local")).list();
    expect(rows[0]?.cached).toBe(false);
    const y = setup(new Map(), db); y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.tasks[0]?.status).toBe("needs-file"));
    expect(y.http.create).not.toHaveBeenCalled();
  });

  it("drops a task completed by another tab and reads its updated draft references", async () => {
    const db = new FileUploadDatabase();
    const x = setup(new Map(), db); x.manager.setSource("local"); await x.manager.ready();
    writeComposerDraft("a", { uploadScopeId: x.scope.id, text: "keep", attachments: [], agentId: null, overrides: {}, workspace: null, greetingIndex: 0 });
    x.attach.mockImplementation(updateDraftAttachments);
    let release!: (value: FileUploadDto) => void;
    x.http.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(x.http.complete).toHaveBeenCalled());
    const y = setup(new Map(), db); y.manager.setSource("local"); await y.manager.ready();
    await vi.waitFor(() => expect(y.scope.tasks[0]?.status).toBe("waiting"));
    await vi.waitFor(() => expect(y.scope.tasks[0]?.controller).toBeUndefined());
    expect(y.http.get).not.toHaveBeenCalled();
    release({ ...x.row, state: "completed", asset });
    await vi.waitFor(() => expect(x.scope.tasks).toHaveLength(0));
    y.manager.retry(y.scope.id, y.scope.tasks[0]!.id);
    await vi.waitFor(() => expect(y.scope.tasks).toHaveLength(0));
    expect(y.scope.attachments).toEqual([asset]); expect(y.http.create).not.toHaveBeenCalled();
  });

  it("revokes a pending save on logout and never restores it into the next session", async () => {
    const db = new FileUploadDatabase(); const session = await db.open("local");
    let first = true;
    const x = setup(new Map(), { open: async (source) => { if (first) { first = false; return session; } return db.open(source); } });
    x.manager.setSource("local"); await x.manager.ready();
    const put = session.put.bind(session); let release!: () => void;
    vi.spyOn(session, "put").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; }); return put(...args);
    });
    x.manager.enqueue(x.scope.id, [x.file]);
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    x.manager.reset(); x.manager.setSource("local"); release(); await x.manager.ready();
    expect(x.manager.all()).toEqual([]);
    expect(await (await db.open("local")).list()).toEqual([]);
    expect(x.http.create).not.toHaveBeenCalled();
  });
});
