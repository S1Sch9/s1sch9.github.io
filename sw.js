const CACHE_NAME = "s1sch9-shell-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./official-logo.svg",
  "./apple-touch-icon.png",
  "./favicon.png"
];

const pageCacheKey = request => {
  const key = new URL(request.url);
  key.search = "";
  key.hash = "";
  return key.href;
};

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("s1sch9-shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.includes("/api/") ||
    url.pathname.startsWith("/admin") ||
    url.pathname.includes("telegram")
  ) return;

  if (request.mode === "navigate") {
    const cacheKey = pageCacheKey(request);
    event.respondWith(
      fetch(request).then(async response => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(cacheKey, response.clone());
        }
        return response;
      }).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cachedPage = await cache.match(cacheKey);
        if (cachedPage) return cachedPage;

        // Only the site's root page may fall back to index.html.
        if (url.pathname === "/" || url.pathname.endsWith("/")) {
          return (await cache.match(new URL("./index.html", self.location.href).href))
            || (await cache.match(new URL("./", self.location.href).href))
            || new Response("Страница недоступна без интернета.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }

        return new Response("Эта страница ещё не сохранена для работы без интернета.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});
