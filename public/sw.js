// Shows the knock when the page is closed, and brings the door forward when tapped.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); } catch { /* empty or non-JSON push */ }
  event.waitUntil(self.registration.showNotification(d.title || 'Knock knock', {
    body: d.body || 'Tap to open the door',
    tag: d.tag || 'knock',
    renotify: true,
    requireInteraction: d.tag === 'knock',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  })());
});
