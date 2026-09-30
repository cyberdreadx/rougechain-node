/* global self, caches */
// RougeChain service-worker retirement ("kill switch").
//
// rougechain.io used to register /sw.js (apps/web, cache "rougechain-v3": network-first HTML,
// cache-first static files). The new site (apps/site-next) does not use a service worker, but
// returning visitors still have the old one installed. Browsers re-check /sw.js on navigation;
// this byte-different script replaces the old worker and retires it:
//   install  → skipWaiting (take over right away)
//   activate → delete EVERY Cache Storage entry this origin's worker made, then unregister.
// No fetch handler: while this worker still controls an open tab, every request goes straight to
// the network, so nothing stale (old index.html, old /status/releases.json, …) is ever served.
// Open tabs are NOT force-reloaded (a reload could interrupt a wallet signature); the next
// navigation is simply uncontrolled.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      } finally {
        await self.registration.unregister();
      }
    })(),
  );
});
