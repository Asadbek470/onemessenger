// This file must be served from the site root (/sw.js) — that's what gives
// it permission to control the whole origin. Registered from app.js.
//
// Обычные push-уведомления + ЗВОНКИ: уведомление «Звонок» с кнопками
// «Принять» / «Отклонить», которое не пропадает само и вибрирует —
// это и есть звонок на заблокированный телефон / закрытое приложение.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function hasVisibleWindow() {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return wins.some((w) => w.visibilityState === "visible");
}

async function closeCallNotifications() {
  const list = await self.registration.getNotifications({ tag: "om-call" });
  list.forEach((n) => n.close());
}

self.addEventListener("push", (event) => {
  let d = { title: "UzMessenger", body: "У тебя новое уведомление", url: "/chat.html" };
  try {
    if (event.data) d = { ...d, ...event.data.json() };
  } catch {}

  event.waitUntil((async () => {
    // Звонок отменён или пропущен — убираем «звонящее» уведомление
    if (d.type === "call-cancel") {
      await closeCallNotifications();
      if (d.missed) {
        await self.registration.showNotification(d.title || "Пропущенный звонок", {
          body: d.body || "", icon: "/icon-192.png?v=2", badge: "/icon-192.png?v=2",
          tag: "om-missed", data: { url: d.url || "/chat.html" }
        });
      }
      return;
    }

    // Если приложение открыто на экране — оно само покажет звонок/сообщение
    if (await hasVisibleWindow()) return;

    if (d.type === "call") {
      await self.registration.showNotification(d.title || "Звонок", {
        body: d.body || "",
        icon: "/icon-192.png?v=2",
        badge: "/icon-192.png?v=2",
        tag: "om-call",
        renotify: true,
        requireInteraction: true,
        vibrate: [700, 350, 700, 350, 700, 350, 700],
        silent: false,
        data: { type: "call", callId: d.callId, url: d.url || "/chat.html" },
        actions: [
          { action: "accept", title: "Принять" },
          { action: "decline", title: "Отклонить" }
        ]
      });
      return;
    }

    if (d.type === "group-call") {
      await self.registration.showNotification(d.title || "Групповой звонок", {
        body: d.body || "",
        icon: "/icon-192.png?v=2",
        badge: "/icon-192.png?v=2",
        tag: "om-group-" + (d.groupId || ""),
        requireInteraction: true,
        vibrate: [300, 150, 300],
        data: { type: "group-call", groupId: d.groupId, url: d.url || "/chat.html" }
      });
      return;
    }

    await self.registration.showNotification(d.title, {
      body: d.body,
      icon: "/icon-192.png?v=2",
      badge: "/icon-192.png?v=2",
      data: { url: d.url || "/chat.html" }
    });
  })());
});

async function openOrFocus(url, message) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of wins) {
    if (client.url.includes("chat.html") && "focus" in client) {
      await client.focus();
      if (message) client.postMessage(message);
      return;
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};

  if (d.type === "call") {
    if (event.action === "decline") {
      event.waitUntil(
        fetch("/api/call/decline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId: d.callId })
        }).catch(() => {})
      );
      return;
    }
    event.waitUntil(openOrFocus(d.url, { type: "accept-call", callId: d.callId }));
    return;
  }

  if (d.type === "group-call") {
    event.waitUntil(openOrFocus(d.url, { type: "join-group", groupId: d.groupId }));
    return;
  }

  event.waitUntil(openOrFocus(d.url || "/chat.html", null));
});
