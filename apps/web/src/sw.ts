/// <reference lib="webworker" />
import { translate, resolveLocale, type MessageKey } from "@llm-chat/i18n";
const t = (key: MessageKey) => translate(resolveLocale(self.navigator.languages), key);

import { cacheNames, clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, getCacheKeyForURL, precacheAndRoute, type PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { OFFLINE_IMAGES_PREFIX, offlineRead, type OfflineControl } from "./lib/offline-db";
import { createNotificationWorker } from "./lib/notification-worker";
import { repairPrecache } from "./lib/repair-precache";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };
const conversationNotifications = createNotificationWorker({ origin: self.location.origin, clients: self.clients, registration: self.registration });

clientsClaim();
cleanupOutdatedCaches();
const precache = self.__WB_MANIFEST;
precacheAndRoute(precache);
let repair: Promise<void> | undefined;

registerRoute(({ url }) => /^\/api\/(images\/|files\/|image-proxy$)/.test(url.pathname), async ({ request }) => {
  try {
    const response = await fetch(request);
    if (![502, 503, 504].includes(response.status)) return response;
    throw new Error("Image service unavailable");
  }
  catch {
    const control = await offlineRead<OfflineControl>("meta", "control").catch(() => undefined);
    if (control?.enabled && control.authorized) {
      const cached = await (await caches.open(OFFLINE_IMAGES_PREFIX + control.epoch)).match(request);
      if (cached) return cached;
    }
    return new Response(t("sw.this_image_has_not_been_downloaded_connect_to_view_it"), { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
});

// Unmatched API requests go straight to the browser network. Intercepting SSE
// with respondWith keeps an old worker alive and can block Chromium activation.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }));

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
  if (event.data?.type === "REPAIR_PRECACHE" && event.source && "id" in event.source) {
    repair ??= repairPrecache(cacheNames.precache, precache.map((entry) => {
      const url = typeof entry === "string" ? entry : entry.url;
      return {
        url: new URL(url, self.registration.scope).href,
        key: getCacheKeyForURL(url)!,
        ...(typeof entry !== "string" && entry.integrity ? { integrity: entry.integrity } : {})
      };
    }), async (signal) => {
      const response = await fetch(`/readyz?repair=${Date.now()}`, { cache: "no-store", signal });
      const health = await response.json() as { ok?: boolean; buildId?: string };
      if (!response.ok || health.ok !== true || typeof event.data.buildId !== "string" || health.buildId !== event.data.buildId) {
        throw new Error("Server release changed during download");
      }
    }).finally(() => { repair = undefined; });
    event.waitUntil(repair.then(
      () => event.ports[0]?.postMessage({ ok: true }),
      () => event.ports[0]?.postMessage({ ok: false })
    ));
  }
  if (event.data?.type === "CHAT_NOTIFICATIONS" && event.source && "id" in event.source) {
    event.waitUntil(conversationNotifications.handle(event.data.command, event.source.id).then(
      () => event.ports[0]?.postMessage({ ok: true }),
      () => event.ports[0]?.postMessage({ ok: false, error: t("sw.could_not_show_the_notification_check_browser_permissions_or_try") })
    ));
  }
});

self.addEventListener("notificationclick", (event) => {
  if (!event.notification.tag.startsWith("llm-chat:")) return;
  event.notification.close();
  event.waitUntil(conversationNotifications.click(event.notification.data));
});
