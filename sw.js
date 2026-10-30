// Service Worker v1 для КогдаБенз
// Стратегия: статика — cache-first (мгновенное открытие), API — network-first с фолбэком на кэш
const CACHE_VERSION = 'kogdabenz-v145';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './maskable-192.png',
  './maskable-512.png',
  'life-hero.png',
  '01_sobiraem_dannye.png', 
  '02_analiziruem_teplovuyu_kartu.png', 
  '03_proveryaem_dostupnost.png', 
  '04_schitaem_vremya_i_ocheredi.png', 
  '05_proveryaem_marshrut.png', 
  '06_finalnye_shtrihi.png', 
  'whatsnew-tg.png',
  'whatsnew-mail.png',
  'whatsnew-advice.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
];

// Кэш плиток карты: cache-first, ограничение 2000 записей (примерно 100 МБ)
const TILE_CACHE = 'kogdabenz-tiles-v136';
const MAX_TILES = 2000;

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const toDelete = keys.slice(0, keys.length - MAX_TILES);
    for (const req of toDelete) await cache.delete(req);
  }
}

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
          // в кэш кладём только успешные ответы: 503 не должен консервироваться
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_VERSION).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
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
  // Плитки карты OpenFreeMap: cache-first + кэширование новых
  else if (url.includes('tiles.openfreemap.org') || url.includes('demotiles.maplibre.org')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(TILE_CACHE).then(cache => {
              cache.put(event.request, responseClone);
              trimTileCache();
            });
          }
          return response;
        });
      })
    );
  }
  // Остальная статика: cache-first (мгновенное открытие, даже если сеть медленная)
  else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request);
      })
    );
  }
});