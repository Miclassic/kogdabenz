// Service Worker v1 для КогдаБенз
// Стратегия: статика — cache-first (мгновенное открытие), API — network-first с фолбэком на кэш
const CACHE_VERSION = 'kogdabenz-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
];

// Установка: кэшируем статику
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      console.log('[SW] Кэширую статику');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // активируем сразу, не ждём закрытия старой вкладки
});

// Активация: чистим старые кэши (если была предыдущая версия)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_VERSION).map(key => {
          console.log('[SW] Удаляю старый кэш:', key);
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim(); // берём контроль над всеми открытыми вкладками
});

// Fetch: статика — из кэша, API — сеть с фолбэком на кэш
self.addEventListener('fetch', event => {
  const url = event.request.url;
  // API Supabase: network-first (всегда свежие данные, но если сеть упала — показываем кэш)
  if (url.includes('/rest/v1/') || url.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // обновляем кэш свежим ответом
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // сеть упала — пытаемся достать из кэша
          return caches.match(event.request).then(cached => {
            return cached || new Response('{"error":"offline"}', { status: 503 });
          });
        })
    );
  }
  // Статика: cache-first (мгновенное открытие, даже если сеть медленная)
  else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request);
      })
    );
  }
});
