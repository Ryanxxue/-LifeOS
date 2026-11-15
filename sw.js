/* 生活记录面板 service worker —— 由 build.py 生成，请勿手改 */
/* 注册 URL 上的 sharecode 会随 self.location 带进来，因此无需把访问码写死。 */
const VERSION = '1d5b2f07d8';
const CACHE = 'life-board-' + VERSION;
const SC = new URL(self.location.href).searchParams.get('sharecode') || '';
const SHELL = new URL('./', self.location).href + (SC ? '?sharecode=' + encodeURIComponent(SC) : '');

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const c = await caches.open(CACHE);
    try { await c.add(new Request(SHELL, { cache: 'reload' })); } catch (err) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) {
      return k.indexOf('life-board-') === 0 && k !== CACHE;
    }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;   // 云 API / 头像等跨域请求绝不缓存

  // 页面导航：网络优先，成功后刷新离线壳；断网时回退到缓存的应用壳
  if (req.mode === 'navigate') {
    e.respondWith((async function () {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(CACHE);
          await c.put(SHELL, res.clone());
        }
        return res;
      } catch (err) {
        const c = await caches.open(CACHE);
        return (await c.match(SHELL)) || new Response(
          '离线，且本机还没有缓存应用壳。联网打开一次后即可离线使用。',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 同源静态资源：缓存优先（带 sharecode 的图标/manifest 离线也可用）
  e.respondWith((async function () {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') await c.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504 });
    }
  })());
});
