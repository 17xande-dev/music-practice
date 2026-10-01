// The service worker: makes the site installable and usable offline.
// Practice rooms often have poor wifi, and everything the site does
// already happens in the browser, so once visited it works without a
// connection.
//
// Pages are fetched network-first, so a deploy shows up on the next visit
// online, with the cached copy as the fallback offline. Static assets
// carry a content hash in their URL (?v=…), so they are cache-first and
// never stale. On install, each page is fetched and every asset it
// references (bundles, styles, icons, the pitch worklet, starter songs)
// is cached with it, so the whole site works offline after one visit.
//
// The server prepends `const VERSION = "…"` (a hash of every asset), so
// each deploy is a new worker that replaces the old caches.

/// <reference lib="webworker" />
// No exports here: the worker is a classic script, not a module.
import { assetUrls } from "./lib/sw_assets.ts";

declare const VERSION: string;
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `mp-${typeof VERSION === "string" ? VERSION : "dev"}`;
const PAGES = ["/", "/songs", "/progress", "/about"];

async function precache() {
  const cache = await caches.open(CACHE);
  for (const page of PAGES) {
    const res = await fetch(page, { cache: "no-cache" });
    if (!res.ok) continue;
    const html = await res.clone().text();
    await cache.put(page, res);
    // One failed asset shouldn't stop the rest from being cached.
    await Promise.allSettled(assetUrls(html).map((u) => cache.add(u)));
  }
  await Promise.allSettled(
    ["/static/manifest.webmanifest", "/static/icon-192.png", "/static/icon-512.png"].map((u) =>
      cache.add(u)
    ),
  );
}

sw.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== sw.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(page(req, url));
  } else if (url.pathname.startsWith("/static/") && url.searchParams.has("v")) {
    e.respondWith(asset(req));
  }
});

/** Network first; offline, the cached page (a shared link's query string doesn't matter). */
async function page(req: Request, url: URL): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && PAGES.includes(url.pathname)) await cache.put(url.pathname, res.clone());
    return res;
  } catch {
    return (await cache.match(url.pathname)) ?? (await cache.match("/")) ??
      new Response("You're offline, and this page hasn't been saved yet.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
  }
}

/** Hashed assets never change: cache first. */
async function asset(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}
