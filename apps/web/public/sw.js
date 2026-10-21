// Orlok service worker (R-CHAT-1, R-CHAT-7): installable app and push notifications.
// Nothing is cached: the app always needs the server, and stale data would be misleading.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Payload sent by the server: { title, body, url, tag }. The url is a path of the app.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Orlok", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/icons/icon-192.png",
      // Android draws the badge from its alpha channel only: a white silhouette on transparent.
      badge: "/icons/badge-96.png",
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          await client.navigate(url).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
