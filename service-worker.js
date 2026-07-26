// 不缓存应用资源，并清理早期版本遗留的永久 Cache Storage。
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter(name => name.startsWith('libre-tv-') || name.startsWith('libretv-'))
        .map(name => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});
