import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FILE_UPLOAD_CHUNK_BYTES, fileUploadInputSchema, type FileUploadDto, type FileUploadInput } from "@llm-chat/contracts";
import { withMessage } from "@llm-chat/i18n";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./database";
import { ImageService, sniffImage } from "./images";

const TTL = 24 * 60 * 60 * 1000;
interface UploadRow { id: string; file_name: string; mime_type: string; byte_size: number; sha256: string; offset: number; state: FileUploadDto["state"]; expires_at: number; error: string | null }

export class UploadError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
const failure = (status: number, code: "unavailable" | "expired" | "conflict" | "incomplete" | "chunk_too_large" | "empty_chunk" | "image_limit" | "disk_full" | "hash_mismatch" | "invalid_body") => withMessage(new UploadError(status, code), `uploads.${code}`);

export class FileUploads {
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly streams = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly store: Store, private readonly images: ImageService) {
    this.root = join(store.dataDir, "file-uploads");
  }
  private path(id: string) { return join(this.root, `${id}.part`); }
  private row(id: string): UploadRow | undefined {
    return this.store.sqlite.prepare("SELECT * FROM file_uploads WHERE id = ?").get(id) as unknown as UploadRow | undefined;
  }
  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw failure(503, "unavailable");
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(() => { if (this.closed) throw failure(503, "unavailable"); return operation(); });
    this.locks.set(id, next);
    try { return await next; }
    finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup();
    for (const { id } of this.store.sqlite.prepare("SELECT id FROM file_uploads WHERE state IN ('uploading','checking')").all() as { id: string }[]) {
      const row = this.row(id)!;
      if (this.store.getFileAsset(id)) {
        this.store.sqlite.prepare("UPDATE file_uploads SET state = 'completed', error = NULL WHERE id = ?").run(id);
        await rm(this.path(id), { force: true });
        continue;
      }
      try {
        const info = await stat(this.path(id));
        if (info.size < row.offset) throw failure(409, "incomplete");
        await truncate(this.path(id), row.offset);
        if (row.state === "checking") this.finishLater(id);
      } catch {
        this.store.sqlite.prepare("UPDATE file_uploads SET state = 'failed', error = 'incomplete' WHERE id = ?").run(id);
      }
    }
    this.timer = setInterval(() => { void this.cleanup().catch(() => {}); }, 60 * 60 * 1000);
    this.timer.unref();
  }
  get(id: string): FileUploadDto {
    const row = this.row(id);
    if (!row || row.expires_at <= Date.now()) throw failure(404, "expired");
    return { id, fileName: row.file_name, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
      offset: row.offset, state: row.state, expiresAt: row.expires_at, error: row.error,
      asset: row.state === "completed" ? this.store.getFileAsset(id) ?? null : null };
  }
  async create(input: FileUploadInput): Promise<FileUploadDto> {
    input = fileUploadInputSchema.parse(input);
    return this.locked(input.id, async () => {
      const old = this.row(input.id);
      if (old) {
        const value = this.get(input.id);
        if (value.sha256 !== input.sha256 || value.byteSize !== input.byteSize || value.fileName !== input.fileName || value.mimeType !== input.mimeType) throw failure(409, "conflict");
        return value;
      }
      if (this.store.getFileAsset(input.id)) throw failure(409, "conflict");
      try { await writeFile(this.path(input.id), new Uint8Array(), { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") { await rm(this.path(input.id), { force: true }); throw failure(507, "disk_full"); }
        throw error;
      }
      try {
        this.store.sqlite.prepare("INSERT INTO file_uploads (id,file_name,mime_type,byte_size,sha256,expires_at) VALUES (?,?,?,?,?,?)")
          .run(input.id, input.fileName, input.mimeType, input.byteSize, input.sha256, Date.now() + TTL);
      } catch (error) { await rm(this.path(input.id), { force: true }); throw error; }
      return this.get(input.id);
    });
  }
  async append(id: string, offset: number, body: Readable): Promise<FileUploadDto> {
    return this.locked(id, async () => {
      const value = this.get(id);
      if (value.state !== "uploading" || value.offset !== offset) throw failure(409, "conflict");
      const controller = new AbortController();
      this.streams.set(id, controller);
      const abortBody = () => body.destroy(controller.signal.reason);
      controller.signal.addEventListener("abort", abortBody, { once: true });
      let size = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > FILE_UPLOAD_CHUNK_BYTES || offset + size > value.byteSize) callback(failure(413, "chunk_too_large"));
        else callback(null, chunk);
      } });
      try {
        await pipeline(Readable.from(body.iterator({ destroyOnReturn: false })), limit, createWriteStream(this.path(id), { flags: "r+", start: offset }), { signal: controller.signal });
        if (!size) throw failure(400, "empty_chunk");
        if (!offset) {
          const file = await open(this.path(id), "r");
          try {
            const header = Buffer.alloc(12);
            await file.read(header, 0, 12, 0);
            if (sniffImage(header) && value.byteSize > 5 * 1024 ** 2) throw failure(413, "image_limit");
          } finally { await file.close(); }
        }
        const file = await open(this.path(id), "r+");
        try { await file.sync(); } finally { await file.close(); }
        controller.signal.throwIfAborted();
        this.store.sqlite.prepare("UPDATE file_uploads SET offset = ?, expires_at = ? WHERE id = ?").run(offset + size, Date.now() + TTL, id);
        return this.get(id);
      } catch (error) {
        await truncate(this.path(id), offset);
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw failure(507, "disk_full");
        throw error;
      } finally { this.streams.delete(id); controller.signal.removeEventListener("abort", abortBody); body.resume(); }
    });
  }
  async complete(id: string): Promise<FileUploadDto> {
    const value = this.get(id);
    if (value.state === "completed" || value.state === "checking") return value;
    if ((value.state !== "uploading" && !(value.state === "failed" && value.error === "disk_full")) || value.offset !== value.byteSize) throw failure(409, "incomplete");
    // Mark synchronously before enqueueing, so repeated completion cannot enqueue another finalizer.
    this.store.sqlite.prepare("UPDATE file_uploads SET state = 'checking', expires_at = ? WHERE id = ?").run(Date.now() + TTL, id);
    this.finishLater(id);
    return this.get(id);
  }
  private finishLater(id: string): void {
    void this.locked(id, async () => {
      const value = this.get(id);
      const controller = new AbortController();
      this.streams.set(id, controller);
      try {
        const hash = createHash("sha256");
        const header = Buffer.alloc(12);
        let size = 0;
        for await (const chunk of createReadStream(this.path(id), { signal: controller.signal })) {
          const bytes = chunk as Buffer;
          if (size < 12) bytes.copy(header, size, 0, Math.min(12 - size, bytes.length));
          size += bytes.length;
          hash.update(bytes);
        }
        if (size !== value.byteSize || hash.digest("hex") !== value.sha256) throw failure(422, "hash_mismatch");
        controller.signal.throwIfAborted();
        await this.images.commitUploadedFile(this.path(id), value, header);
        this.store.sqlite.prepare("UPDATE file_uploads SET state = 'completed', expires_at = ?, error = NULL WHERE id = ?").run(Date.now() + TTL, id);
        await rm(this.path(id), { force: true });
      } catch (error) {
        if (!this.closed) {
          const raw = (error as { code?: string }).code;
          const code = raw === "ENOSPC" ? "disk_full" : raw === "image_too_large" ? "image_limit" : raw === "hash_mismatch" ? raw : "incomplete";
          this.store.sqlite.prepare("UPDATE file_uploads SET state = 'failed', error = ? WHERE id = ?").run(code, id);
        }
      } finally { this.streams.delete(id); }
    }).catch(() => {});
  }
  async cancel(id: string): Promise<void> {
    this.streams.get(id)?.abort();
    await this.locked(id, async () => {
      await rm(this.path(id), { force: true });
      this.store.sqlite.prepare("DELETE FROM file_uploads WHERE id = ?").run(id);
    });
  }
  async cleanup(now = Date.now()): Promise<void> {
    for (const row of this.store.sqlite.prepare("SELECT id FROM file_uploads WHERE expires_at <= ?").all(now) as { id: string }[]) {
      if (!this.locks.has(row.id)) await this.cancel(row.id);
    }
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f\d-]{36}\.part$/i.test(entry.name)) continue;
      const id = entry.name.slice(0, -5);
      if (!this.row(id) && !this.locks.has(id)) await rm(join(this.root, entry.name), { force: true });
    }
    await this.images.cleanupOrphans(now);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.streams.values()) controller.abort();
    await Promise.allSettled([...this.locks.values()]);
  }
}

export async function registerFileUploadRoutes(app: FastifyInstance, uploads: FileUploads): Promise<void> {
  await app.register(async (routes) => {
    routes.removeContentTypeParser("application/octet-stream");
    routes.addContentTypeParser("application/octet-stream", (_request, stream, done) => done(null, stream));
    const params = z.object({ id: z.string().uuid() });
    routes.post("/api/file-uploads", async (request, reply) => reply.code(201).send(await uploads.create(fileUploadInputSchema.parse(request.body))));
    routes.get("/api/file-uploads/:id", async (request) => uploads.get(params.parse(request.params).id));
    routes.patch("/api/file-uploads/:id", { config: { decompress: false } }, async (request) => {
      const id = params.parse(request.params).id;
      const { offset } = z.object({ offset: z.coerce.number().int().nonnegative() }).parse(request.query);
      if (!(request.body instanceof Readable)) throw failure(400, "invalid_body");
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw failure(415, "invalid_body");
      return uploads.append(id, offset, request.body);
    });
    routes.post("/api/file-uploads/:id/complete", async (request, reply) => {
      const value = await uploads.complete(params.parse(request.params).id);
      return reply.code(value.state === "completed" ? 200 : 202).send(value);
    });
    routes.delete("/api/file-uploads/:id", async (request, reply) => {
      await uploads.cancel(params.parse(request.params).id);
      return reply.code(204).send();
    });
  });
}
