#!/usr/bin/env python3
"""生活记录面板 —— 构建发布产物 + 发布前检查。

用法：
  python3 build.py          生成 index.html / sw.js / manifest.webmanifest
  python3 build.py --check  只检查不写文件：产物是否最新、有无外链、JS 语法、sw.js 是否同步

背景：发布站点要求每个静态资源都带 sharecode，外链 <script src> 不带码会 403，
所以所有 JS 必须内联进 index.html；图标与 PWA manifest 用 data URI 内联。
service worker 用真实同源脚本 sw.js（注册 URL 带 sharecode），由本脚本注入版本戳。
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

JS_FILES = ['wbcloud.js', 'config.js', 'coros.js', 'weread.js', 'app.js']
OWN_JS = ['config.js', 'coros.js', 'weread.js', 'app.js']
ASSET_TAG = '<!--__LB_ASSETS__-->'

SW_TEMPLATE = """/* 生活记录面板 service worker —— 由 build.py 生成，请勿手改 */
/* 注册 URL 上的 sharecode 会随 self.location 带进来，因此无需把访问码写死。 */
const VERSION = '__VERSION__';
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
"""


def read(name):
    with open(name, encoding='utf-8') as f:
        return f.read()


def data_uri(name):
    with open(name, 'rb') as f:
        return 'data:image/png;base64,' + base64.b64encode(f.read()).decode()


def build_all():
    html = read('index.src.html')
    for name in JS_FILES:
        tag = '<script src="%s"></script>' % name
        if tag not in html:
            raise SystemExit('index.src.html 缺少引入标签：' + name)
        html = html.replace(tag, '<script>\n' + read(name) + '\n</script>')
    if ASSET_TAG not in html:
        raise SystemExit('index.src.html 缺少资源占位符 ' + ASSET_TAG)

    # 版本戳取源码内容 hash：内容不变则 SW 不升级，内容一变必然换缓存
    # 版本戳也覆盖构建脚本与 SW 模板：改了构建逻辑必须换缓存，否则线上会继续用旧壳
    digest = hashlib.sha256(
        (read('index.src.html') + ''.join(read(n) for n in JS_FILES) +
         SW_TEMPLATE + read(os.path.basename(__file__))).encode('utf-8')
    ).hexdigest()[:10]

    icons = {'192': data_uri('icon-192.png'), '512': data_uri('icon-512.png')}
    assets = ('<script>window.__LB_ICONS__=' +
              json.dumps(icons, ensure_ascii=False, separators=(',', ':')) +
              ';window.__LB_BUILD__=' + json.dumps(digest) + ';</script>')
    html = html.replace(ASSET_TAG, assets)
    html = html.replace('href="icon-180.png"', 'href="' + data_uri('icon-180.png') + '"')
    # head 解析阶段就会请求 <link rel=manifest>；相对路径不带 sharecode 必然 403。
    # 这里内联一个极小的占位 manifest，运行时 installManifest() 再用带动态 start_url 的
    # blob manifest 覆盖它（完整图标也由运行时注入），全程不产生 403 请求。
    mini = {'name': '生活记录', 'short_name': '生活记录', 'display': 'standalone', 'start_url': '/'}
    mini_uri = ('data:application/manifest+json;base64,' +
                base64.b64encode(json.dumps(mini, ensure_ascii=False).encode('utf-8')).decode())
    html = html.replace('href="manifest.webmanifest"', 'href="' + mini_uri + '"')

    manifest = {
        'name': '生活记录', 'short_name': '生活记录',
        'description': '打卡、阅读、学习与身体数据，一个面板全部收好。',
        'start_url': '/', 'scope': '/', 'display': 'standalone', 'orientation': 'portrait',
        'background_color': '#000000', 'theme_color': '#000000',
        'icons': [
            {'src': icons['192'], 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': icons['512'], 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any maskable'}
        ]
    }
    return {
        'index.html': html,
        'sw.js': SW_TEMPLATE.replace('__VERSION__', digest),
        'manifest.webmanifest': json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    }, digest


def build():
    files, digest = build_all()
    for name, content in files.items():
        with open(name, 'w', encoding='utf-8') as f:
            f.write(content)
    print('built %s' % digest)
    for name in ('index.html', 'sw.js', 'manifest.webmanifest'):
        print('  %-24s %.1f KB' % (name, os.path.getsize(name) / 1024))
    return 0


def check():
    files, digest = build_all()
    problems = []
    for name, expect in files.items():
        if not os.path.exists(name):
            problems.append('缺少产物 ' + name)
            continue
        if read(name) != expect:
            problems.append('%s 与源码不一致 —— 改过源码后忘记跑 python3 build.py' % name)
    html = files['index.html']
    if re.search(r'<script\s+[^>]*src=', html):
        problems.append('index.html 仍有外链 <script src>（线上不带 sharecode 会 403）')
    if 'icon-192.png"' in html or 'icon-512.png"' in html:
        problems.append('PWA 图标仍是相对路径，线上会 403，必须内联为 data URI')
    if 'href="manifest.webmanifest"' in html:
        problems.append('head 的 manifest 仍是相对路径，JS 执行前会先发一次 403 请求')
    if '__LB_ICONS__' not in html or '__LB_BUILD__' not in html:
        problems.append('缺少内联图标/构建号常量')
    if 'serviceWorker' not in html:
        problems.append('未注册 service worker')
    if not os.path.exists('tests/regression.py'):
        problems.append('回归测试脚本缺失')

    for name in OWN_JS + ['sw.js']:
        if not os.path.exists(name):
            problems.append('缺少 ' + name)
            continue
        try:
            r = subprocess.run(['node', '--check', name], capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                problems.append('%s 语法错误：%s' % (name, (r.stderr or '').strip().splitlines()[-1:]))
        except FileNotFoundError:
            break   # 无 node 时跳过语法检查
        except Exception as e:
            problems.append('无法检查 %s：%s' % (name, e))

    if problems:
        print('发布前检查未通过：')
        for p in problems:
            print('  ✗ ' + p)
        return 1
    print('发布前检查通过 · 版本 %s · index.html %.1f KB · 无外链 · JS 语法 OK' %
          (digest, len(html.encode('utf-8')) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(check() if '--check' in sys.argv else build())
