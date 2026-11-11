// Service Worker КогдаБенз
// статика — stale-while-revalidate; API — network-first; плитки — cache-first
const CACHE_VERSION = 'kogdabenz-v261'; // <-- БАМП при каждом релизе
const TILE_CACHE = 'kogdabenz-tiles-v136';
const MAX_TILES = 2000;

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

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const toDelete = keys.slice(0, keys.length - MAX_TILES);
    for (const req of toDelete) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[SW] Кэширую статику', CACHE_VERSION);
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // не трогаем текущий кэш статики и кэш плиток
          .filter((key) => key !== CACHE_VERSION && key !== TILE_CACHE)
          .map((key) => {
            console.log('[SW] Удаляю старый кэш:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// страница может форсировать активацию
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  // сам SW и любые ?updatecheck= — только сеть
  if (url.includes('/sw.js') || url.includes('updatecheck=')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // API Supabase — network-first
  if (url.includes('/rest/v1/') || url.includes('supabase.co')) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(req).then(
            (cached) =>
              cached ||
              new Response('{"error":"offline"}', {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              })
          )
        )
    );
    return;
  }

  // плитки карты — cache-first
  if (url.includes('tiles.openfreemap.org') || url.includes('demotiles.maplibre.org')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(TILE_CACHE).then((cache) => {
              cache.put(req, clone);
              trimTileCache();
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML/JS/CSS — stale-while-revalidate: сразу из кэша, в фоне обновляем
  const isDoc =
    req.mode === 'navigate' ||
    url.includes('.html') ||
    url.includes('.js') ||
    url.includes('.css');

  if (isDoc) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req)
          .then((response) => {
            if (response.ok) cache.put(req, response.clone());
            return response;
          })
          .catch(() => null);
        // есть кэш — отдаём его, сеть обновит на следующий раз
        if (cached) {
          networkPromise.catch(() => {});
          return cached;
        }
        // кэша нет — ждём сеть
        const net = await networkPromise;
        return (
          net ||
          new Response('Офлайн', { status: 503, statusText: 'Offline' })
        );
      })
    );
    return;
  }

  // прочее — cache, иначе сеть
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});