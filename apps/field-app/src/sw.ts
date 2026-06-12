import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

// Precache the entire app shell (JS, CSS, HTML) so the app loads offline.
// vite-plugin-pwa injects the manifest at build time; in dev mode this is
// an empty array (dev assets are served directly from the dev server).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Background Sync handler — fires when the device reconnects after registering
// a sync tag via SyncManager.register("fhir-flush").
// We can't call flush() directly here (Dexie lives in the client context),
// so we post a FLUSH message to all active window clients instead.
self.addEventListener("sync", (event) => {
  if (event.tag === "fhir-flush") {
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          clients.forEach((c) => c.postMessage({ type: "FLUSH" }));
        })
    );
  }
});

// Activate immediately — take control of all open tabs without waiting for reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
