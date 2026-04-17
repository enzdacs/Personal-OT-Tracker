const CACHE_NAME = 'otracker-v1.1';
const STATIC_FILES = [
  '/index.html', '/dashboard.html', '/attendance.html',
  '/overtime.html', '/schedule.html', '/settings.html',
  '/style.css', '/utils.js', '/dashboard.js', '/attendance.js',
  '/overtime.js', '/schedule.js', '/settings.js', '/auth.js',
  '/notifications.js', '/firebase-config.js', '/OTracker-logo.png'
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
