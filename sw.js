/* 生活记录面板 service worker —— 由 build.py 生成，请勿手改 */
/* 注册 URL 上的 sharecode 会随 self.location 带进来，因此无需把访问码写死。 */
const VERSION = '86194a5d39';
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
    const stale = keys.filter(function (k) {
      return k.indexOf('life-board-') === 0 && k !== CACHE;
    });
    await Promise.all(stale.map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
    // 有旧版本被清掉＝这是一次升级（而非首次安装）：告知页面刷新一次即可用上新版
    if (stale.length) {
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach(function (c) { c.postMessage({ type: 'lb-updated', version: VERSION }); });
    }
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;   // 云 API / 头像等跨域请求绝不缓存

  // 页面导航：缓存优先秒开，同时后台拉新版写回缓存（下次打开生效）。
  // 服务端不压缩、每次导航 246 KB 原样传输，网络优先在移动网络下代价明显；
  // 新版本由 activate 里的 lb-updated 消息提示，用户刷新一次就能用上，不会静默落后。
  if (req.mode === 'navigate') {
    const network = fetch(req).then(function (res) {
      if (!res || !res.ok) return res;
      return caches.open(CACHE).then(function (c) {
        return c.put(SHELL, res.clone()).catch(function () {});
      }).then(function () { return res; });
    }).catch(function () { return null; });

    e.respondWith((async function () {
      const c = await caches.open(CACHE);
      const cached = await c.match(SHELL);
      if (cached) return cached;
      const res = await network;
      return res || new Response(
        '离线，且本机还没有缓存应用壳。联网打开一次后即可离线使用。',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());

    // 保活到后台写入完成：否则 respondWith 一结束，写入可能被中断
    e.waitUntil(network.then(function () {}).catch(function () {}));
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
