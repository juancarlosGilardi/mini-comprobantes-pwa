const CACHE_NAME = 'mini-pwa-poc-v1';
const ARCHIVOS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './sql-wasm.js',
  './sql-wasm.wasm',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((clave) => clave !== CACHE_NAME).map((clave) => caches.delete(clave)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  evento.respondWith(
    caches.match(evento.request).then((respuesta) => respuesta || fetch(evento.request))
  );
});
