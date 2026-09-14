import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_FILE_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, fileUploadInputSchema, type FileUploadInput } from "@llm-chat/contracts";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { FileUploads } from "./file-uploads";
import { ImageService, attachmentFileName } from "./images";

const services: FileUploads[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); vi.restoreAllMocks(); cleanupStores(); });
async function setup() {
  const store = createStore(); const images = new ImageService(store); await images.initialize();
  const uploads = new FileUploads(store, images); services.push(uploads); await uploads.initialize();
  return { store, images, uploads };
}
const inputFor = (bytes: Buffer, patch: Partial<FileUploadInput> = {}): FileUploadInput => ({
  id: randomUUID(), fileName: "report.bin", mimeType: "application/octet-stream", byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), ...patch
});
async function finish(uploads: FileUploads, id: string) {
  await uploads.complete(id);
  await vi.waitFor(() => expect(uploads.get(id).state).not.toBe("checking"));
  return uploads.get(id);
}

describe("resumable file uploads", () => {
  it("persists confirmed bytes, discards unconfirmed tails after restart, and completes idempotently", async () => {
    const { store, images, uploads } = await setup(); const bytes = Buffer.from("0123456789"); const input = inputFor(bytes);
    expect(await uploads.create(input)).toMatchObject({ offset: 0, state: "uploading", asset: null });
    expect(await uploads.create(input)).toMatchObject({ id: input.id });
    await expect(uploads.create({ ...input, fileName: "different" })).rejects.toMatchObject({ statusCode: 409 });
    await uploads.append(input.id, 0, Readable.from([bytes.subarray(0, 4)]));
    await expect(uploads.append(input.id, 0, Readable.from([bytes]))).rejects.toMatchObject({ statusCode: 409 });
    await expect(uploads.complete(input.id)).rejects.toMatchObject({ statusCode: 409 });
    await uploads.close();
    await appendFile(join(uploads.root, `${input.id}.part`), "uncommitted");
    const restarted = new FileUploads(store, images); services.push(restarted); await restarted.initialize();
    expect((await stat(join(uploads.root, `${input.id}.part`))).size).toBe(4);
    await restarted.append(input.id, 4, Readable.from([bytes.subarray(4)]));
    const complete = await finish(restarted, input.id);
    expect(complete).toMatchObject({ state: "completed", asset: { id: input.id, sha256: input.sha256, byteSize: 10 } });
    expect(await restarted.complete(input.id)).toEqual(complete);
    expect(await restarted.create(input)).toEqual(complete);
    expect((await images.readFileAsset(input.id)).bytes).toEqual(new Uint8Array(bytes));
    await expect(stat(join(uploads.root, `${input.id}.part`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.unreferencedFileAssets(Date.now() + 10_000)).toEqual([]);
    await restarted.cancel(input.id);
    expect(store.getFileAsset(input.id)).toBeTruthy();
  });

  it("rolls back empty, oversized, interrupted, and disk-full chunks without losing acknowledged bytes", async () => {
    const { uploads } = await setup(); const bytes = Buffer.alloc(FILE_UPLOAD_CHUNK_BYTES + 10, 5); const input = inputFor(bytes);
    await uploads.create(input);
    await expect(uploads.append(input.id, 0, Readable.from([]))).rejects.toMatchObject({ code: "empty_chunk" });
    await expect(uploads.append(input.id, 0, Readable.from([bytes]))).rejects.toMatchObject({ statusCode: 413 });
    await uploads.append(input.id, 0, Readable.from([Buffer.from("first")]));
    for (const code of ["ECONNRESET", "ENOSPC"]) {
      const interrupted = Readable.from((async function* () { yield Buffer.from("partial"); throw Object.assign(new Error(code), { code }); })());
      await expect(uploads.append(input.id, 5, interrupted)).rejects.toMatchObject({ code: code === "ENOSPC" ? "disk_full" : code });
      expect(uploads.get(input.id).offset).toBe(5);
      expect(await readFile(join(uploads.root, `${input.id}.part`), "utf8")).toBe("first");
    }
    const tiny = inputFor(Buffer.from("x")); await uploads.create(tiny);
    await expect(uploads.append(tiny.id, 0, Readable.from([Buffer.from("xx")]))).rejects.toMatchObject({ code: "chunk_too_large" });
  });

  it("rejects changed bytes and detects images by content, including headers split across chunks", async () => {
    const { uploads, images } = await setup();
    const bad = inputFor(Buffer.from("good")); await uploads.create(bad);
    await uploads.append(bad.id, 0, Readable.from([Buffer.from("evil")]));
    expect(await finish(uploads, bad.id)).toMatchObject({ state: "failed", error: "hash_mismatch", asset: null });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const image = inputFor(png);
    await uploads.create(image); await uploads.append(image.id, 0, Readable.from([png]));
    expect(await finish(uploads, image.id)).toMatchObject({ asset: { kind: "image", mimeType: "image/png" } });
    const large = inputFor(png, { byteSize: 6 * 1024 ** 2 }); await uploads.create(large);
    await expect(uploads.append(large.id, 0, Readable.from([png]))).rejects.toMatchObject({ code: "image_limit" });
    expect(uploads.get(large.id).offset).toBe(0);
    const largeBytes = Buffer.alloc(6 * 1024 ** 2); png.copy(largeBytes);
    const split = inputFor(largeBytes); await uploads.create(split);
    await uploads.append(split.id, 0, Readable.from([largeBytes.subarray(0, 1)]));
    await uploads.append(split.id, 1, Readable.from([largeBytes.subarray(1, FILE_UPLOAD_CHUNK_BYTES)]));
    await uploads.append(split.id, FILE_UPLOAD_CHUNK_BYTES, Readable.from([largeBytes.subarray(FILE_UPLOAD_CHUNK_BYTES)]));
    expect(await finish(uploads, split.id)).toMatchObject({ state: "failed", asset: null });
    await expect(images.fileAssetLocation(split.id)).rejects.toMatchObject({ code: "file_asset_not_found" });
  });

  it("cancels active streams and cleans expired and orphan staging files", async () => {
    const { uploads, store } = await setup(); const input = inputFor(Buffer.from("12345")); await uploads.create(input);
    const source = new Readable({ read() {} });
    const write = uploads.append(input.id, 0, source); const rejected = expect(write).rejects.toThrow();
    source.push("1"); await vi.waitFor(async () => expect((await stat(join(uploads.root, `${input.id}.part`))).size).toBe(1));
    await uploads.cancel(input.id); await rejected;
    expect(() => uploads.get(input.id)).toThrow(); await uploads.cancel(input.id);
    const expired = inputFor(Buffer.from("x")); await uploads.create(expired);
    store.sqlite.prepare("UPDATE file_uploads SET expires_at = 0 WHERE id = ?").run(expired.id);
    expect(() => uploads.get(expired.id)).toThrow();
    const orphan = join(uploads.root, `${randomUUID()}.part`); await writeFile(orphan, "x");
    await writeFile(join(uploads.root, "keep.txt"), "leave unrelated files alone");
    await mkdir(join(uploads.root, "keep-dir"));
    await uploads.cleanup();
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM file_uploads").get()).toEqual({ n: 0 });
  });

  it("recovers interrupted finalization and records missing staging files", async () => {
    const { uploads, store, images } = await setup(); const bytes = Buffer.from("resume finalize"); const input = inputFor(bytes);
    await uploads.create(input); await uploads.append(input.id, 0, Readable.from([bytes]));
    store.sqlite.prepare("UPDATE file_uploads SET state = 'checking' WHERE id = ?").run(input.id);
    const missing = inputFor(Buffer.from("lost")); await uploads.create(missing);
    await rm(join(uploads.root, `${missing.id}.part`));
    await uploads.close();
    const restored = new FileUploads(store, images); services.push(restored); await restored.initialize();
    await vi.waitFor(() => expect(restored.get(input.id).state).toBe("completed"));
    expect(restored.get(missing.id)).toMatchObject({ state: "failed", error: "incomplete" });
    // Crash after publishing an asset but before saving its completed state.
    store.sqlite.prepare("UPDATE file_uploads SET state = 'checking' WHERE id = ?").run(input.id);
    await restored.close();
    const again = new FileUploads(store, images); services.push(again); await again.initialize();
    expect(again.get(input.id).state).toBe("completed");
    await expect(uploads.create(inputFor(bytes))).rejects.toMatchObject({ statusCode: 503 });
  });

  it("retries finalization after disk space is freed and rejects collisions with existing asset IDs", async () => {
    const { uploads, images } = await setup(); const bytes = Buffer.from("retry publish"); const input = inputFor(bytes);
    await uploads.create(input); await uploads.append(input.id, 0, Readable.from([bytes]));
    vi.spyOn(images, "commitUploadedFile").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    expect(await finish(uploads, input.id)).toMatchObject({ state: "failed", error: "disk_full", offset: bytes.length });
    expect(await finish(uploads, input.id)).toMatchObject({ state: "completed", asset: { id: input.id } });
    await uploads.cancel(input.id);
    await expect(uploads.create(input)).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("enforces 2 GiB files and 4 GiB messages without allocating large buffers, preserving isolated workspace copies", async () => {
    const { uploads, store, images } = await setup(); seedModel(store);
    expect(fileUploadInputSchema.safeParse(inputFor(Buffer.from("a"), { byteSize: MAX_ATTACHMENT_FILE_BYTES })).success).toBe(true);
    for (const byteSize of [0, -1, MAX_ATTACHMENT_FILE_BYTES + 1]) expect(fileUploadInputSchema.safeParse(inputFor(Buffer.from("a"), { byteSize })).success).toBe(false);
    const bytes = Buffer.from("isolation"); const input = inputFor(bytes); await uploads.create(input); await uploads.append(input.id, 0, Readable.from([bytes]));
    const asset = (await finish(uploads, input.id)).asset!;
    const conversation = store.createConversation({ systemPrompt: "" });
    const generation = store.createMessageGeneration(conversation.id, "read", [asset.id]);
    await images.materializeMessageAttachments(conversation.id, generation.userMessageId!);
    await writeFile(join(images.attachmentWorkspace(conversation.id), "incoming", generation.userMessageId!, attachmentFileName(asset)), "modified");
    expect((await images.readFileAsset(asset.id)).bytes).toEqual(new Uint8Array(bytes));
    const a = store.createFileAsset({ sha256: "a".repeat(64), fileName: "a", mimeType: "application/octet-stream", kind: "file", byteSize: MAX_ATTACHMENT_FILE_BYTES, storageKey: "a" });
    const b = store.createFileAsset({ sha256: "b".repeat(64), fileName: "b", mimeType: "application/octet-stream", kind: "file", byteSize: MAX_ATTACHMENT_FILE_BYTES, storageKey: "b" });
    expect(MAX_MESSAGE_ATTACHMENT_BYTES).toBe(a.byteSize + b.byteSize);
    expect(() => store.validateAttachments([a.id, b.id])).not.toThrow();
    expect(() => store.validateAttachments([a.id, b.id, asset.id])).toThrow("4 GiB");
    await expect(images.readFileAsset(a.id)).rejects.toMatchObject({ code: "file_too_large" });
  });
});
