/**
 * Service worker.
 *
 * Hand-written rather than generated. `next-pwa` is unmaintained and
 * webpack-only, and `@serwist/next` ships a webpack plugin — Next 16 builds
 * with Turbopack by default, so adopting either would mean opting out of the
 * default bundler for about sixty lines of caching. Not a good trade.
 *
 * The caching policy is deliberately conservative, because this is health
 * data:
 *
 *   navigations      network-first, falling back to cache, then /offline
 *   /_next/static/*  cache-first (content-hashed, so safe forever)
 *   /api/*           NEVER cached
 *
 * That last rule matters twice over. A stale health number is worse than no
 * number — you would act on it — and cached API responses would leave a copy
 * of someone's medical data sitting in Cache Storage for anything with access
 * to the origin to read.
 */

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) =>
        cache.addAll([OFFLINE_URL, "/icons/icon-192.png"]).catch(() => {
          // A failed precache must not abort installation — the worker is
          // still useful without the offline page.
        }),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL && k !== STATIC)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses. Health data must not sit in Cache Storage, and
  // a stale reading is worse than none.
  if (url.pathname.startsWith("/api/")) return;

  // Hashed build assets are immutable, so cache-first is free performance.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(STATIC).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // Pages: network-first, so you always get fresh numbers when you can.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match(OFFLINE_URL)),
        ),
    );
  }
});
