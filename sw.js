// Service Worker: App-Shell und Datenbank offline verfügbar machen.
const VERSION = "nw-2026-11-11-1";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "js/app.js", "js/add.js", "js/ui.js", "js/db.js", "js/store.js", "js/nutrition.js", "js/portions.js",
  "js/off.js", "js/ai.js", "js/camera.js", "vendor/anthropic-sdk.mjs", "vendor/zxing.mjs", "data/foods.json",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // APIs (Claude, Open Food Facts) nie cachen
  // Stale-while-revalidate für eigene Dateien
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
