// Service worker mínimo: cache do "casco" do app para abrir rápido e funcionar como PWA.
// Nunca guarda respostas da API (dados e mídias privadas ficam sempre no servidor).
// Só /assets/ (nome com hash do Vite) e /fonts/ vêm do cache primeiro; o resto busca na rede e usa o cache
// só sem conexão, para que um logo ou ícone trocado apareça na hora (antes o logo antigo ficava preso no cache).
const CACHE = 'marcos-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png', '/marcos-logo.png']))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/public/')) return;
  if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request).catch(() => caches.match('/'))); return; }
  const save = (r) => { if (r.ok && /\.(js|css|woff2|png|svg|webp)$/.test(url.pathname)) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; };
  if (/^\/(assets|fonts)\//.test(url.pathname)) { e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(save))); return; }
  e.respondWith(fetch(e.request).then(save).catch(() => caches.match(e.request)));
});
