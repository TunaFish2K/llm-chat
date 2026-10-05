/// <reference lib="webworker" />
import { translate, resolveLocale, type MessageKey } from "@llm-chat/i18n";
const t = (key: MessageKey) => translate(resolveLocale(self.navigator.languages), key);

import { OFFLINE_IMAGES_PREFIX, offlineRead, type OfflineControl } from "./lib/offline-db";
import { createNotificationWorker } from "./lib/notification-worker";
import { activateShell, activateStagedShell, installShell, matchShell } from "./lib/app-shell";

declare let self: ServiceWorkerGlobalScope;
const conversationNotifications = createNotificationWorker({ origin: self.location.origin, clients: self.clients, registration: self.registration });
const IMAGE_ROUTE = /^\/api\/(images\/|files\/|image-proxy$)/;
// Plain fetch() calls (destination "") such as /readyz go straight to the network.
const SHELL_DESTINATIONS = new Set(["document", "iframe", "script", "style", "image", "font", "manifest", "worker"]);

// A new worker waits for the user to apply it, so installation only prepares
// the shell published by the page origin. It keeps the current shell when that
// origin still serves the same release.
self.addEventListener("install", (event) => {
  event.waitUntil(installShell(self.location.origin).then(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await activateStagedShell();
    // Releases before the self-managed shell kept their files in Workbox caches.
    for (const name of await caches.keys()) if (name.startsWith("workbox-precache")) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function imageResponse(request: Request, url: URL): Promise<Response> {
  try {
    const response = await fetch(request);
    if (![502, 503, 504].includes(response.status)) return response;
    throw new Error("Image service unavailable");
  }
  catch {
    const control = await offlineRead<OfflineControl>("meta", "control").catch(() => undefined);
    if (control?.enabled && control.authorized) {
      // Offline copies are keyed by path, whichever channel downloaded them.
      const cached = await (await caches.open(OFFLINE_IMAGES_PREFIX + control.epoch)).match(self.location.origin + url.pathname + url.search);
      if (cached) return cached;
    }
    return new Response(t("sw.this_image_has_not_been_downloaded_connect_to_view_it"), { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function shellResponse(request: Request, url: URL): Promise<Response> {
  const cached = await matchShell(url.pathname, request.mode === "navigate").catch(() => undefined);
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (["http:", "https:"].includes(url.protocol) && IMAGE_ROUTE.test(url.pathname)) {
    event.respondWith(imageResponse(request, url));
    return;
  }
  // Unmatched API requests go straight to the browser network. Intercepting SSE
  // with respondWith keeps an old worker alive and can block Chromium activation.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode !== "navigate" && !SHELL_DESTINATIONS.has(request.destination)) return;
  event.respondWith(shellResponse(request, url));
});

function reply(event: ExtendableMessageEvent, work: Promise<unknown>, failure?: string): void {
  event.waitUntil(work.then(
    (result) => event.ports[0]?.postMessage({ ok: true, result }),
    (error: unknown) => event.ports[0]?.postMessage({ ok: false, error: failure ?? (error instanceof Error ? error.message : String(error)) })
  ));
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
  if (event.data?.type === "INSTALL_SHELL" && typeof event.data.base === "string") {
    reply(event, installShell(event.data.base, { force: event.data.force === true }));
  }
  if (event.data?.type === "ACTIVATE_SHELL" && typeof event.data.id === "string") {
    reply(event, activateShell(event.data.id));
  }
  if (event.data?.type === "CHAT_NOTIFICATIONS" && event.source && "id" in event.source) {
    reply(event, conversationNotifications.handle(event.data.command, event.source.id),
      t("sw.could_not_show_the_notification_check_browser_permissions_or_try"));
  }
});

self.addEventListener("notificationclick", (event) => {
  if (!event.notification.tag.startsWith("llm-chat:")) return;
  event.notification.close();
  event.waitUntil(conversationNotifications.click(event.notification.data));
});
