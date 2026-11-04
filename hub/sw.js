// Service worker: shows referral alerts and opens the referral card when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New TCSA referral', {
    body: d.body || 'Open the hub to back it up.',
    tag: d.tag || undefined,
    icon: 'https://kvebnkzjbvlxljlyeeqg.supabase.co/storage/v1/object/public/branding/icon-180-v3.png',
    badge: 'https://kvebnkzjbvlxljlyeeqg.supabase.co/storage/v1/object/public/branding/emblem-96-v3.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('navigate' in w) { try { await w.navigate(url); } catch (_) {} }
      if ('focus' in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
