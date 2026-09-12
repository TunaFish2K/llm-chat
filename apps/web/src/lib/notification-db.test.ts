import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

beforeEach(() => { vi.resetModules(); vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => vi.restoreAllMocks());

it("defaults off, persists browser preferences, and rejects stale permission decisions", async () => {
  const db = await import("./notification-db");
  expect(await db.readNotificationControl()).toEqual({ enabled: false, authorized: false, revision: "initial" });
  const enabled = await db.writeNotificationControl({ enabled: true, authorized: true }, "initial");
  expect(await db.readNotificationControl()).toEqual(enabled);
  const disabled = await db.writeNotificationControl({ enabled: false });
  await expect(db.writeNotificationControl({ enabled: true }, enabled.revision)).rejects.toThrow("设置已变化");
  expect(await db.readNotificationControl()).toEqual(disabled);
});

it("deduplicates concurrent claims and keeps a bounded history across reloads", async () => {
  let timestamp = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++timestamp);
  const db = await import("./notification-db");
  expect(await Promise.all([db.claimNotification("same"), db.claimNotification("same")])).toEqual([true, false]);
  for (let i = 0; i < 1001; i++) await db.claimNotification(`event-${i}`);
  vi.resetModules();
  const reloaded = await import("./notification-db");
  expect(await reloaded.claimNotification("event-1000")).toBe(false);
  expect(await reloaded.claimNotification("same")).toBe(true);
});

it("recovers from failed database initialization", async () => {
  const error = new DOMException("blocked", "SecurityError");
  const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw error; });
  const db = await import("./notification-db");
  await expect(db.readNotificationControl()).rejects.toThrow("blocked");
  expect((await db.readNotificationControl()).enabled).toBe(false);
  expect(open).toHaveBeenCalledTimes(2);
});

it("closes an old connection when the database version changes", async () => {
  const db = await import("./notification-db");
  await db.readNotificationControl();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("llm-chat-notifications");
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  expect((await db.readNotificationControl()).revision).toBe("initial");
});

it("persists locale independently of authorization revisions and seen events", async () => {
  const db = await import("./notification-db");
  const control = await db.writeNotificationControl({ enabled: true, authorized: true });
  expect(await db.claimNotification("already-seen")).toBe(true);
  expect(await db.notificationLocale()).toBe("zh-CN");
  expect(await db.notificationLocale("en-US")).toBe("en-US");
  vi.resetModules();
  const reloaded = await import("./notification-db");
  expect(await reloaded.notificationLocale()).toBe("en-US");
  expect(await reloaded.readNotificationControl()).toEqual(control);
  expect(await reloaded.claimNotification("already-seen")).toBe(false);
  expect(await reloaded.notificationLocale("zh-CN")).toBe("zh-CN");
});
