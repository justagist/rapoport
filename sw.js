// Service worker: the shell is precached and refreshed from the network when
// online; the Python runtime, the wheels, the editor and the fonts are cached
// the first time they are fetched, so later visits work offline.

const SHELL = "rapoport-shell-v2";
const RUNTIME = "rapoport-runtime-v1";
const SHELL_FILES = ["./", "index.html", "guide.html", "app.css", "app.js", "worker.js", "py/engine.py", "manifest.webmanifest", "icons/mark.svg", "icons/icon-192.png", "icons/icon-512.png"];
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "esm.sh", "pypi.org", "files.pythonhosted.org", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin) {
    e.respondWith(networkFirst(e.request));
  } else if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(e.request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok || fresh.type === "opaque") cache.put(request, fresh.clone());
  return fresh;
}
