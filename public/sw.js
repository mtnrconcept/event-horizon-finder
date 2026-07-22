/* Global Party service worker — public shell only, no authenticated data caching. */
const VERSION = "global-party-v3-2026-07-22";
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;
const OFFLINE_URL = "/offline.html";
const STATIC_ASSETS = [
  "/",
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.ico",
  "/brand/global-party-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("global-party-") && ![STATIC_CACHE, PAGE_CACHE].includes(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isSensitivePath(pathname) {
  return [
    "/auth",
    "/profile",
    "/favorites",
    "/agenda",
    "/organizer",
    "/admin",
    "/settings",
    "/reset-password",
    "/mcp",
    "/api",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isCacheablePublicPage(pathname) {
  return (
    pathname === "/" ||
    pathname === "/map" ||
    pathname.startsWith("/event/") ||
    pathname === "/help" ||
    pathname === "/faq"
  );
}

async function networkFirst(request, cacheName, timeoutMs = 4_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match(OFFLINE_URL);
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    void network.catch(() => undefined);
    return cached;
  }
  return network.catch(() => new Response("Ressource indisponible hors ligne.", { status: 503 }));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isSensitivePath(url.pathname)) return;

  if (request.mode === "navigate") {
    if (!isCacheablePublicPage(url.pathname)) return;
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
    /\.(?:css|js|woff2?|png|jpe?g|webp|avif|svg|ico)$/i.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
