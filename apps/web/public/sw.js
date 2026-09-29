// Cache version — bump to invalidate all previously cached responses on activate.
const CACHE_NAME = "rougechain-v3";
const PRECACHE_URLS = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Skip API calls and cross-origin resources.
  if (url.pathname.startsWith("/api") || url.hostname !== self.location.hostname) return;

  // ── HTML documents (navigations) → NETWORK-FIRST ─────────────────────────────
  // The app shell must always be fresh: a stale cached index.html references hashed
  // JS/CSS bundles that no longer exist after a deploy, which 404 and leave a white
  // screen on first load (a refresh then picks up the revalidated shell). Fetch the
  // live document, cache it as a fallback, and only fall back to cache when offline.
  const isDocument =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");
  if (isDocument) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/index.html"))
        )
    );
    return;
  }

  // ── Static assets (content-hashed, immutable) → CACHE-FIRST + background refresh ──
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || fetched;
    })
  );
});
