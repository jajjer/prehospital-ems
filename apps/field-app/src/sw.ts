/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";

declare let self: ServiceWorkerGlobalScope;

// Precache the entire app shell (JS, CSS, HTML) so the app loads offline.
// vite-plugin-pwa injects the manifest at build time; in dev mode this is
// an empty array (dev assets are served directly from the dev server).
// config.json is deliberately excluded from the manifest (see vite.config.ts)
// and handled network-first below.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Per-facility runtime config (issue #14): serve /config.json network-first so an
// edit on the host takes effect on the next online boot WITHOUT a rebuild, while a
// cached copy keeps the app working offline. Precaching it would pin a stale copy
// to the build, so it is excluded from the precache manifest. Hand-written (no
// workbox-strategies dependency): try the network, update the cache on success,
// and fall back to the cache when offline.
const CONFIG_CACHE = "runtime-config";
registerRoute(
  ({ url }) => url.pathname === "/config.json",
  async ({ request }) => {
    const cache = await self.caches.open(CONFIG_CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }
  }
);

// Background Sync handler — fires when the device reconnects after registering
// a sync tag via SyncManager.register("fhir-flush").
// SyncEvent is a Chrome-only API not in the standard TypeScript DOM lib.
interface SyncEvent extends ExtendableEvent { readonly tag: string }
interface SyncEventMap { sync: SyncEvent }
type SyncableWorker = typeof self & {
  addEventListener<K extends keyof SyncEventMap>(type: K, listener: (ev: SyncEventMap[K]) => void): void;
};
(self as SyncableWorker).addEventListener("sync", (event) => {
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

// Don't skip waiting automatically — the app detects the waiting SW and shows
// a non-blocking "Update available" banner so in-flight captures aren't interrupted.
// The app sends SKIP_WAITING when the responder taps the banner.
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
