// Service Worker — Rendio Turnos
// Estrategia:
//   - Assets estáticos (HTML/JS/CSS/SVG/PNG): stale-while-revalidate.
//     La app sirve rápido desde caché, pero descarga la versión fresca en
//     background y actualiza el caché para la próxima visita.
//   - Llamadas a Supabase: NUNCA cachear (datos sensibles + necesitan estar
//     frescos siempre). Pasan directo a la red.

const CACHE_VERSION = 'rendio-turnos-v20';
const APP_SHELL = [
  '/',
  '/index.html',
  '/config.js',
  '/supabase-client.js',
  '/scheduler.js',
  '/api.js',
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // No cachear nada que no sea del propio origen (Supabase, CDNs externos, etc.)
  if (url.origin !== self.location.origin) return;

  // GET only
  if (event.request.method !== 'GET') return;

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
