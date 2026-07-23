const CACHE_PREFIX = "clickbait";
// Bump when the worker or core-shell contract changes so an installing worker
// never mutates the cache still owned by the active version.
const CACHE_VERSION = "2026-07-22-v2";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;
const MAX_RUNTIME_ENTRIES = 80;
const CORE_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

async function cacheUrl(cache, rawUrl) {
  const url = new URL(rawUrl, self.location.origin);
  if (url.origin !== self.location.origin || url.pathname === "/sw.js") return;

  const request = new Request(url.href, {
    cache: "reload",
    credentials: "same-origin",
  });
  const response = await fetch(request);

  if (!response.ok) throw new Error(`Could not cache ${url.pathname}: ${response.status}`);
  await cache.put(request, response);
}

async function precacheCoreShell() {
  const cache = await caches.open(SHELL_CACHE);
  const rootRequest = new Request(new URL("/", self.location.origin), {
    cache: "reload",
    credentials: "same-origin",
  });
  const rootResponse = await fetch(rootRequest);
  if (!rootResponse.ok) {
    throw new Error(`Could not cache the app shell: ${rootResponse.status}`);
  }

  // Cache the exact HTML and its content-hashed Next assets as one install
  // transaction. A failed asset keeps the prior worker and caches active.
  const html = await rootResponse.clone().text();
  await cache.put(rootRequest, rootResponse);
  const shellAssets = new Set(CORE_ASSETS.filter((url) => url !== "/"));
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
    const asset = new URL(match[1], self.location.origin);
    if (asset.origin === self.location.origin && asset.pathname.startsWith("/_next/static/")) {
      shellAssets.add(asset.href);
    }
  }
  await Promise.all([...shellAssets].map((url) => cacheUrl(cache, url)));
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;

  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheCoreShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith(`${CACHE_PREFIX}-`) &&
              key !== SHELL_CACHE &&
              key !== RUNTIME_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await clients.claim();
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === "PRECACHE_URLS" && Array.isArray(event.data.urls)) {
    const precache = caches.open(RUNTIME_CACHE).then(async (cache) => {
      await Promise.all(event.data.urls.slice(0, 40).map((url) => cacheUrl(cache, url)));
      await trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
    });
    event.waitUntil(precache);
    const replyPort = event.ports?.[0];
    if (replyPort) {
      precache.then(
        () => replyPort.postMessage({ ok: true }),
        () => replyPort.postMessage({ ok: false }),
      );
    }
  }
});

async function fetchNavigationWithTimeout(request, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function networkFirstNavigation(request) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);

  try {
    const response = await fetchNavigationWithTimeout(request);
    if (response.status >= 500) throw new Error(`Navigation failed: ${response.status}`);
    if (response.ok) {
      await runtimeCache.put(request, response.clone());
      trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES).catch(() => {});
    }
    return response;
  } catch {
    const shellCache = await caches.open(SHELL_CACHE);
    const cachedResponse =
      (await runtimeCache.match(request, { ignoreSearch: true })) ??
      (await shellCache.match("/", { ignoreSearch: true })) ??
      (await shellCache.match("/offline.html"));

    return (
      cachedResponse ??
      new Response("Clickbait is offline and no app shell is cached yet.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
    }
    return response;
  } catch {
    return Response.error();
  }
}

function staleWhileRevalidate(event) {
  const { request } = event;
  const update = caches.open(RUNTIME_CACHE).then(async (cache) => {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
    }
    return response;
  });

  // Keep the worker alive for the refresh even when the cached response wins.
  event.waitUntil(update.then(() => undefined, () => undefined));
  return caches.open(RUNTIME_CACHE).then(async (cache) => {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;
    try {
      return await update;
    } catch {
      return Response.error();
    }
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const cacheableDestination = ["font", "image", "script", "style"].includes(
    request.destination,
  );
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (cacheableDestination) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
