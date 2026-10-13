/* Readalong service worker.
 *  - App shell: network-first, falls back to cache (so updates show up, and it works offline).
 *  - Book files (EPUB, audio, json): cache-first, filled on first use, so a book
 *    can be listened to offline after it has been opened once.
 *  - Range requests (needed for audio seeking) are answered from the cached copy.
 */
const VERSION = "readalong-v3";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "vendor/jszip.min.js",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "books/catalog.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Book media is immutable between builds: cache-first.
  // Book metadata/catalog can change when new books are added: network-first.
  if (url.pathname.includes("/books/") && !url.pathname.endsWith(".json")) {
    event.respondWith(bookResponse(req));
  } else {
    event.respondWith(shellResponse(req));
  }
});

async function shellResponse(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match("index.html"));
  }
}

async function bookResponse(req) {
  const cache = await caches.open(VERSION);
  const cacheKey = new Request(new URL(req.url).pathname);
  const cached = await cache.match(cacheKey);

  if (req.headers.has("range")) {
    // The audio element always asks for ranges, so fetch the whole file once
    // (without the Range header), cache it, and serve slices from the cache.
    let full = cached;
    if (!full) {
      const res = await fetch(new Request(req.url, { credentials: req.credentials }));
      if (!res.ok || res.status !== 200) return res;
      cache.put(cacheKey, res.clone());
      full = res;
    }
    return sliceRange(full, req.headers.get("range"));
  }

  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(cacheKey, res.clone());
  return res;
}

async function sliceRange(cachedRes, rangeHeader) {
  const buf = await cachedRes.arrayBuffer();
  const total = buf.byteLength;
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
  if (match && !match[1] && match[2]) {
    // suffix range: last N bytes
    start = Math.max(0, total - parseInt(match[2], 10));
    end = total - 1;
  }
  end = Math.min(end, total - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": cachedRes.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
