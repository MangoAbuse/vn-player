// Service worker: keeps the player's own files so it opens with no network.
// Game data never goes through here; it is read from the device's storage by the page.
// Bump VERSION whenever any file of the player changes.

const VERSION = '1.1.0';
const CACHE = 'vn-player-' + VERSION;
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/util.js',
  'js/zip.js',
  'js/store.js',
  'js/import-worker.js',
  'js/stage.js',
  'js/textbox.js',
  'js/audio.js',
  'js/engine.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('vn-player-') && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(request);
      } catch (error) {
        if (request.mode === 'navigate') {
          const page = await cache.match('index.html');
          if (page) return page;
        }
        throw error;
      }
    }),
  );
});
