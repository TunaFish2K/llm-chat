import { Blob as NodeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it, vi } from "vitest";
import { FileUploadDatabase, MAX_CACHED_UPLOAD_BYTES, UPLOAD_CACHE_TTL, UPLOAD_LEASE_MS } from "./file-upload-db";
import type { UploadScope, UploadTask } from "./file-upload-manager";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("Blob", NodeBlob); });
const scope: UploadScope = { id: "conversation:a", conversationId: "a", attachments: [], tasks: [] };
const task: UploadTask = { id: "one", fileName: "one.txt", mimeType: "text/plain", byteSize: 3,
  image: false, created: false, offset: 0, hashedBytes: 0, status: "queued", error: null };

it("stores binary payloads independently of metadata and restores them across connections", async () => {
  const session = await new FileUploadDatabase().open("server");
  expect(await session.put(scope, task, new Blob(["abc"]))).toBe(true);
  await session.put(scope, { ...task, created: true, offset: 2 });
  const restored = await new FileUploadDatabase().open("server");
  expect(await restored.list()).toEqual([expect.objectContaining({ cached: true, scopeId: scope.id, task: expect.objectContaining({ offset: 2 }) })]);
  const claim = await restored.claim(task.id);
  expect(claim.state).toBe("claimed");
  if (claim.state === "claimed") expect(await claim.blob?.text()).toBe("abc");
});

it("caches the inclusive 64 MiB boundary and keeps only receipts for larger files", async () => {
  const session = await new FileUploadDatabase().open("server");
  const file = new Blob([new Uint8Array(MAX_CACHED_UPLOAD_BYTES)]);
  await session.put(scope, { ...task, byteSize: file.size }, file);
  await session.put(scope, { ...task, id: "large", byteSize: file.size + 1 }, new Blob([file, "x"]));
  const small = await session.claim(task.id); const large = await session.claim("large");
  expect(small.state === "claimed" && small.blob?.size).toBe(MAX_CACHED_UPLOAD_BYTES);
  expect(large.state === "claimed" && large.blob).toBeUndefined();
});

it("claims atomically across tabs, renews leases, and permits takeover after a crashed tab", async () => {
  let now = 100;
  const db = new FileUploadDatabase("leases", () => now);
  const first = await db.open("server"); const second = await db.open("server");
  await first.put(scope, task, new Blob(["abc"]));
  const claims = await Promise.all([first.claim(task.id), second.claim(task.id)]);
  expect(claims.map((claim) => claim.state)).toEqual(["claimed", "busy"]);
  expect(await second.put(scope, { ...task, offset: 2 })).toBe(false);
  now += UPLOAD_LEASE_MS - 1;
  expect(await first.renew(task.id)).toBe(true);
  now += 2;
  expect((await second.claim(task.id)).state).toBe("busy");
  now += UPLOAD_LEASE_MS;
  expect((await second.claim(task.id)).state).toBe("claimed");
  expect(await first.renew(task.id)).toBe(false);
  await first.release(task.id);
  expect((await first.claim(task.id)).state).toBe("busy");
  await second.release(task.id);
  expect((await first.claim(task.id)).state).toBe("claimed");
});

it("deletes bytes on cancellation and rejects late writes using tombstones", async () => {
  const session = await new FileUploadDatabase().open("server");
  await session.put(scope, task, new Blob(["abc"]));
  await session.remove(task.id);
  expect(await session.put(scope, task, new Blob(["late"]))).toBe(false);
  expect(await session.list()).toEqual([]);
  expect((await session.claim(task.id)).state).toBe("missing");
});

it("takes over immediately after the owning document closes, while preserving live tab exclusion", async () => {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: {
    request: async (name: string, callback: () => Promise<void>) => {
      held.add(name);
      try { await callback(); } finally { held.delete(name); }
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) })
  } });
  const db = new FileUploadDatabase("document-locks", () => 100);
  const first = await db.open("server"); const firstLock = [...held][0]!;
  const second = await db.open("server");
  const third = await db.open("server");
  await first.put(scope, task, new Blob(["abc"]));
  expect((await first.claim(task.id)).state).toBe("claimed");
  expect((await second.claim(task.id)).state).toBe("busy");
  held.delete(firstLock); // Closing a document releases Web Locks, without completing its database writes.
  expect((await Promise.all([second.claim(task.id), third.claim(task.id)])).map((claim) => claim.state)).toEqual(["claimed", "busy"]);
  expect(await first.renew(task.id)).toBe(false);
  await second.clear(); await third.clear();
});

it("revokes old sessions on logout, isolates sources, and cleans expired uploads", async () => {
  let now = 100;
  const db = new FileUploadDatabase("cleanup", () => now);
  const first = await db.open("server"); const other = await db.open("other");
  await first.put(scope, task, new Blob(["abc"])); await other.put(scope, task);
  await first.clear();
  expect(await first.put(scope, task)).toBe(false);
  expect(await first.renew(task.id)).toBe(false);
  const next = await db.open("server");
  expect(await next.list()).toEqual([]);
  expect(await other.list()).toHaveLength(1);
  await next.put(scope, task, new Blob(["abc"]));
  now += UPLOAD_CACHE_TTL + 1;
  expect(await next.list()).toEqual([]);
  expect((await next.claim(task.id)).state).toBe("missing");
});

it("retries database initialization after storage becomes available", async () => {
  const db = new FileUploadDatabase();
  vi.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw new DOMException("denied", "SecurityError"); });
  await expect(db.open("server")).rejects.toThrow("denied");
  expect(await (await db.open("server")).list()).toEqual([]);
});
