/* Draw Map service worker — app shell plus a capped runtime cache for map tiles. */
var CACHE = 'draw-map-app-v4';
var TILE_CACHE = 'draw-map-tiles-v1';
var TILE_MAX = 180;
var TILE_HOSTS = {
  'tile.openstreetmap.org': 1,
  'server.arcgisonline.com': 1,
  'services.arcgisonline.com': 1,
  'basemaps.cartocdn.com': 1,
  'a.basemaps.cartocdn.com': 1,
  'b.basemaps.cartocdn.com': 1,
  'c.basemaps.cartocdn.com': 1,
  'd.basemaps.cartocdn.com': 1
};
var SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './manifest.json',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './apple-touch-icon.png'
];

function isTileRequest(url) {
  if (!TILE_HOSTS[url.hostname]) return false;
  return /tile|MapServer|basemaps|\.png|\.jpg/i.test(url.href);
}

function trimTileCache(cache, max) {
  return cache.keys().then(function (keys) {
    if (keys.length <= max) return;
    return Promise.all(keys.slice(0, keys.length - max).map(function (k) {
      return cache.delete(k);
    }));
  });
}

function tileResponse(req) {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          cache.put(req, copy).then(function () { return trimTileCache(cache, TILE_MAX); });
        }
        return res;
      });
      if (cached) {
        net.catch(function () { /* stale-while-revalidate */ });
        return cached;
      }
      return net;
    });
  }).catch(function () {
    return fetch(req);
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE && k !== TILE_CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (isTileRequest(url)) event.respondWith(tileResponse(req));
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return caches.match(req);
      });
    })
  );
});
