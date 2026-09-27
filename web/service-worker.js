// App shell cache. API calls always go to the network.
const CACHE_NAME = 'aidedmind-v9';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './app.css',
    './manifest.webmanifest',
    './js/app.js',
    './js/api.js',
    './js/db.js',
    './js/graph.js',
    './js/markdown.js',
    './js/icons.js',
    './js/zip.js',
    './js/readable.js',
    './js/photos.js',
    './js/library.js',
    './vendor/Readability.js',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

    if (request.mode === 'navigate') {
        // Network first so updates land; fall back to the cached shell
        // (this also covers /share?url=… launched from the share sheet).
        event.respondWith(
            fetch(request).catch(() => caches.match('./index.html'))
        );
        return;
    }
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            });
            return cached || network;
        })
    );
});
