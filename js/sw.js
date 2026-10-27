var CACHE_NAME = 'skynet-cache-v3';
var OFFLINE_URL = './in.html';

var PRECACHE_ASSETS = [
  './',
  './in.html',
  './login.html',
  './register.html',
  './perm.html',
  './dash.html',
  './plan1.html',
  './plan2.html',
  './th.html',
  './router.html',
  './ussd.html',
  './withdraw.html',
  './call.html',
  './manifest.json',
  './css/style.css',
  './js/config.js',
  './js/supabase.js',
  './js/loader.js',
  './js/icons.js',
  './js/db.js',
  './js/mirror.js',
  './js/meter.js',
  './js/main.js',
  './js/login.js',
  './js/register.js',
  './js/perm.js',
  './js/dash.js',
  './js/plan1.js',
  './js/plan2.js',
  './js/th.js',
  './js/router.js',
  './js/ussd.js',
  './js/vpn.js',
  './js/pin.js',
  './js/logger.js',
  './js/withdraw.js',
  './js/call.js',
  './assets/images/icon.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return Promise.allSettled(
          PRECACHE_ASSETS.map(function(url) {
            return cache.add(new Request(url, { cache: 'reload' }));
          })
        );
      })
      .then(function() {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          return cacheName !== CACHE_NAME;
        }).map(function(cacheName) {
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var req = event.request;

  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.pathname.indexOf('/api/') !== -1 || url.hostname.indexOf('supabase.co') !== -1) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function(response) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, copy);
          });
          return response;
        })
        .catch(function() {
          return caches.match(req).then(function(cached) {
            return cached || caches.match(OFFLINE_URL);
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(response) {
        var cacheable = response && response.status === 200 &&
          (response.type === 'basic' || url.hostname === 'cdn.jsdelivr.net');
        if (cacheable) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, copy);
          });
        }
        return response;
      });
    })
  );
});

self.addEventListener('push', function(event) {
  var notificationData = 'New update SkyNet WiFi!';
  if (event.data) {
    notificationData = event.data.text();
  }
  var options = {
    body: notificationData,
    icon: './assets/images/icon.png',
    badge: './assets/images/icon.png',
    vibrate: [100, 50, 100],
    data: {
      url: './in.html'
    }
  };
  event.waitUntil(
    self.registration.showNotification('SkyNet WiFi', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = new URL('./in.html', self.registration.scope).href;
  if (event.notification.data && event.notification.data.url) {
    targetUrl = new URL(event.notification.data.url, self.registration.scope).href;
  }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
