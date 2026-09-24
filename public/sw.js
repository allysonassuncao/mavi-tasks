// Service worker for the installable app (PWA). It keeps the app shell and
// the hashed build assets available offline; data always comes from the
// network (Supabase, GCS and /api are never cached).
const CACHE = "workspace-shell-v2";
const SHELL = [
  "/",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192-v2.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
    return;

  // Pages: network first (always the latest deploy), cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Build assets are content-hashed: cache first, fill on demand.
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/")
  ) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// Web Push (api/push.ts): shown even with the app closed. The tag is the
// notification's id, so the same notice never shows twice.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Workspace", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Workspace", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icons/icon-192-v2.png",
      badge: "/icons/icon-192-v2.png",
      data: { url: data.url || "/" },
    }),
  );
});

// Opens the task: an open window of the app shows it without reloading
// (App listens for "mavi:open"); otherwise a new window starts on it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find(
          (w) => new URL(w.url).origin === self.location.origin,
        );
        if (!open)
          return self.clients.openWindow(
            new URL(path, self.location.origin).href,
          );
        open.postMessage({ type: "mavi:open", url: path });
        return open.focus();
      }),
  );
});
