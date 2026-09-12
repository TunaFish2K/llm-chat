/// <reference lib="webworker" />
import { translate, resolveLocale, type MessageKey } from "@llm-chat/i18n";
const t = (key: MessageKey) => translate(resolveLocale(self.navigator.languages), key);

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { OFFLINE_IMAGES_PREFIX, offlineRead, type OfflineControl } from "./lib/offline-db";
import { NetworkOnly } from "workbox-strategies";
import { createNotificationWorker } from "./lib/notification-worker";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<never> };
const conversationNotifications = createNotificationWorker({ origin: self.location.origin, clients: self.clients, registration: self.registration });

clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

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

registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly());
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }));

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
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
