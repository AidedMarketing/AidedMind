// App shell cache. API calls always go to the network.
const CACHE_NAME = 'aidedmind-v30';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './app.css',
    './tokens.css',
    './shell.css',
    './fonts/Newsreader.ttf',
    './icons/mark.svg',
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
    './js/paywall.js',
    './js/themes.js',
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

    // HTML is part of the release too. A network-first document can combine
    // new markup with an old controller's CSS and JavaScript during an update.
    // Serve the whole shell from this controller's cache until the new worker
    // takes over; app.js then reloads or offers Reload when a draft is active.
    // Share URLs still render the shell and keep their original query string.
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request.mode === 'navigate' ? './index.html' : request);
        return cached || fetch(request);
    }));
});
