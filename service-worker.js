const CACHE_NAME = 'otracker-v1.5';
const STATIC_FILES = [
  '/index.html', '/dashboard.html', '/attendance.html',
  '/overtime.html', '/schedule.html', '/settings.html', '/badges.html',
  '/style.css', '/utils.js', '/dashboard.js', '/attendance.js',
  '/overtime.js', '/schedule.js', '/settings.js', '/auth.js', '/badges.js',
  '/notifications.js', '/firebase-config.js', '/chatbot.js', '/OTracker-logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(response => {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return response;
    })).catch(() => caches.match('/dashboard.html'))
  );
});

// Handle push messages (for future server-side push support)
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'OT Tracker', {
      body:  data.body || '',
      icon:  '/OTracker-logo.png',
      badge: '/OTracker-logo.png',
    })
  );
});

// Tapping a notification should focus an existing tab if one's open, else open a new one
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/dashboard.html');
    })
  );
});
