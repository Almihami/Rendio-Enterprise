// Service Worker — Rendio Turnos
// Estrategia:
//   - Assets estáticos (HTML/JS/CSS/SVG/PNG): stale-while-revalidate.
//     La app sirve rápido desde caché, pero descarga la versión fresca en
//     background y actualiza el caché para la próxima visita.
//   - Llamadas a Supabase: NUNCA cachear (datos sensibles + necesitan estar
//     frescos siempre). Pasan directo a la red.

const CACHE_VERSION = 'rendio-turnos-v36';
const OFFLINE_URL = '/offline.html';
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/config.js',
  '/supabase-client.js',
  '/scheduler.js',
  '/api.js',
  '/shift-flow.js',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/assets/logo.png',
  '/assets/logo-icon.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// --- Web Push (Fase 5) ---
// El servidor (Edge Function send-push) envía un payload JSON { title, body, url }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Rendio Turnos';
  const options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate ? w.navigate(url) : null; return w.focus(); }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : null;
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // No cachear nada que no sea del propio origen (Supabase, CDNs externos, etc.)
  if (url.origin !== self.location.origin) return;

  // GET only
  if (event.request.method !== 'GET') return;

  // Navegación (HTML): si la red falla Y no hay cache, sirve offline.html.
  // Así el usuario nunca ve "pantalla en blanco / sin conexión" del navegador.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((resp) => {
            if (resp && resp.status === 200 && resp.type === 'basic') {
              const clone = resp.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            }
            return resp;
          })
          .catch(() => cached || caches.match(OFFLINE_URL));
        return cached || networkFetch;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => cached); // si la red falla, sirve lo cacheado

      return cached || networkFetch;
    })
  );
});
