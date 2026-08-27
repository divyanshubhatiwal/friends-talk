/* Service worker for Friends Talk.
 *
 * Two jobs, and it is careful about the boundary between them.
 *
 * 1. Serve the app shell offline, so opening the icon on a bad connection shows
 *    the interface rather than a browser error page.
 * 2. Receive push notifications, so someone can be told a friend is online
 *    without the tab being open.
 *
 * What it deliberately does NOT cache: anything under /api or /socket.io. A
 * cached matchmaking response would be worse than no response at all — the
 * whole product is live state, and stale live state is a lie.
 */

const VERSION = 'ft-v1';
const SHELL = `shell-${VERSION}`;

// Enough to render the interface with no network. The socket connection fails
// on its own and the UI already reports that honestly.
const SHELL_ASSETS = [
  '/app',
  '/css/site.css',
  '/css/app.css',
  '/js/config.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // Individually, so one 404 cannot fail the whole install.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live endpoints must never be served from cache.
  if (url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/healthz')) {
    return;
  }

  /*
   * Network first, cache as the fallback.
   *
   * The reverse — cache first — would be faster but would keep showing an old
   * build after a deploy, which for an app that changes this often is the wrong
   * trade. The cache exists for being offline, not for speed.
   */
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation with nothing cached still deserves the app shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/app');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});

// ------------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  let payload = { title: 'Friends Talk', body: 'Someone is looking for a call.' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag || 'friends-talk',
      renotify: false,
      data: { url: payload.url || '/app' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/app';

  // Focus an open tab rather than opening a second one.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/app') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
