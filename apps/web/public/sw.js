// Web Push service worker (7.1). Registered at the web root so it owns the
// push subscription for the whole app.
self.addEventListener("push", (event) => {
  let data = { title: "Mimir", body: "" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch {
    data = { title: "Mimir", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icon.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/chat"));
});
