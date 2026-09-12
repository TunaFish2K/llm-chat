import { translate, type Locale, type MessageKey } from "@llm-chat/i18n";
const t = (key: MessageKey) => translate("zh-CN", key);
export interface NotificationControl {
  enabled: boolean;
  authorized: boolean;
  revision: string;
}

const initial: NotificationControl = { enabled: false, authorized: false, revision: "initial" };
let database: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("llm-chat-notifications", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("control");
      request.result.createObjectStore("seen", { keyPath: "key" }).createIndex("at", "at");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(t("notification_db.notification_storage_is_blocked_by_another_page_close_older_pages")));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

export async function readNotificationControl(): Promise<NotificationControl> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("control").objectStore("control").get("settings");
    request.onsuccess = () => resolve(request.result ?? { ...initial });
    request.onerror = () => reject(request.error);
  });
}

/** A permission request in another tab cannot undo a later switch-off or logout. */
export async function writeNotificationControl(
  patch: Partial<Pick<NotificationControl, "enabled" | "authorized">>, expectedRevision?: string
): Promise<NotificationControl> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("control", "readwrite");
    const store = tx.objectStore("control");
    let next: NotificationControl;
    const request = store.get("settings");
    request.onsuccess = () => {
      const current: NotificationControl = request.result ?? initial;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        tx.abort(); return;
      }
      next = { ...current, ...patch, revision: crypto.randomUUID() };
      store.put(next, "settings");
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error(t("notification_db.notification_settings_changed_try_again")));
  });
}

/** Claim before displaying, across workers/tabs and after worker restarts. */
export async function claimNotification(key: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("seen", "readwrite");
    const seen = tx.objectStore("seen");
    let fresh = false;
    const request = seen.get(key);
    request.onsuccess = () => {
      if (request.result) return;
      fresh = true;
      seen.put({ key, at: Date.now() });
      const count = seen.count();
      count.onsuccess = () => {
        let excess = count.result - 1000;
        if (excess <= 0) return;
        const oldest = seen.index("at").openCursor();
        oldest.onsuccess = () => {
          if (!oldest.result || excess-- <= 0) return;
          oldest.result.delete(); oldest.result.continue();
        };
      };
    };
    tx.oncomplete = () => resolve(fresh);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

/** Locale is independent of permission revisions and notification deduplication. */
export async function notificationLocale(locale?: Locale): Promise<Locale> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("control", locale ? "readwrite" : "readonly");
    const store = tx.objectStore("control");
    let value: Locale = "zh-CN";
    if (locale) { value = locale; store.put(locale, "locale"); }
    else { const request = store.get("locale"); request.onsuccess = () => { if (request.result === "en-US") value = "en-US"; }; }
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
