(function () {
'use strict';

/* ==================== 工具 ==================== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const pad = n => String(n).padStart(2, '0');
const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); };
const parseDay = s => { const a = String(s).split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const TODAY = () => dayKey(new Date());
/* 书名归一化：与 DB 的 books_owner_title_key 唯一索引（lower(btrim(title))）保持一致 */
const normTitle = s => String(s == null ? '' : s).trim().toLowerCase();
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const fmt1 = v => (v === null ? '—' : (Math.round(v * 10) / 10).toFixed(1));

/* 主键统一：DB 的 BIGINT 经 JSON 可能是 number 也可能是 string，DOM 的 data-id 恒为 string。
   内存里一律存字符串、比较一律走 eqId；只有写库时才用 dbId 转回数字。 */
const sid = v => (v === null || v === undefined || v === '') ? null : String(v);
const eqId = (a, b) => a != null && b != null && String(a) === String(b);
const dbId = v => { const n = Number(v); return isFinite(n) ? n : v; };

let toastTimer = null, undoStack = [];
/* 高频删除走「撤销」而不是二次确认：toast 里带 6 秒内可点的撤销按钮。
   用栈保存多条，连续删除时不会互相覆盖。 */
function toast(msg, undoFn, ms) {
  const t = $('#toast'); if (!t) return;
  const now = Date.now();
  if (typeof undoFn === 'function') {
    undoStack.push({ fn: undoFn, at: now });
    while (undoStack.length > 5) undoStack.shift();
  }
  undoStack = undoStack.filter(u => now - u.at < 6500);
  const canUndo = undoStack.length > 0;
  t.innerHTML = esc(msg) + (canUndo ? '<button class="undo" data-act="undo">撤销</button>' : '');
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('on'); },
    canUndo ? 6000 : (ms || 2200));
}

/* 表单草稿：弹层关掉不丢输入，24 小时内再打开自动带回 */
function draftGet(k) {
  try {
    const o = JSON.parse(localStorage.getItem('lb.draft.' + k) || 'null');
    return (o && o.at && Date.now() - o.at < 86400000) ? o.v : null;
  } catch (e) { return null; }
}
function draftSet(k, v) {
  try { localStorage.setItem('lb.draft.' + k, JSON.stringify({ at: Date.now(), v: v })); } catch (e) {}
}
function draftClear(k) {
  try { localStorage.removeItem('lb.draft.' + k); } catch (e) {}
}

/* ==================== 站点访问码 ==================== */
/* 发布站点需要 sharecode 才能打开；它同时是 OAuth 回调与 PWA 启动的必需参数，
   所以统一从当前地址取一次并存下来，保证回调回来时仍能还原。 */
function sharecode() {
  try {
    const sc = new URL(location.href).searchParams.get('sharecode');
    if (sc) { localStorage.setItem('lb.sharecode', sc); return sc; }
    return localStorage.getItem('lb.sharecode') || '';
  } catch (e) { return ''; }
}
function appBase() {
  const sc = sharecode();
  return location.origin + '/' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
}
/* 图标走同源 URL 并带上访问码：发布站点不带 sharecode 会 403。
   这样 192/512 不必以 base64 塞进 HTML，首屏体积少约 130 KB。 */
function iconUrl(n) {
  const sc = sharecode();
  return location.origin + '/icon-' + n + '.png' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
}
function installManifest() {
  const icons = [192, 512].map(function (n) {
    return {
      src: iconUrl(n), sizes: n + 'x' + n, type: 'image/png',
      purpose: n === 512 ? 'any maskable' : 'any'
    };
  });
  const ai = document.querySelector('link[rel="apple-touch-icon"]');
  if (ai) ai.href = iconUrl(180);
  const mf = {
    id: '/', name: '生活记录', short_name: '生活记录',
    description: '打卡、阅读、学习与身体数据。',
    start_url: appBase(),          // 绝对地址，带 sharecode，启动后不会落在 403 的根路径
    scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#000000', theme_color: '#000000',
    icons: icons
  };
  try {
    const blob = new Blob([JSON.stringify(mf)], { type: 'application/manifest+json' });
    const link = document.querySelector('link[rel=manifest]');
    if (link) link.href = URL.createObjectURL(blob);
  } catch (e) {}
}
/* service worker 必须是同源真实脚本（blob:/data: 不能注册）。
   注册 URL 带 sharecode 才能通过发布站点的访问码校验；SW 自己从 self.location 读码。 */
function installSW() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  /* 导航改成缓存优先后，新版本靠 SW 在 activate 时通知一次；这里只提示，不自动刷新，
     避免打断正在填的表单（用户下拉刷新即可应用）。 */
  try {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      const d = ev && ev.data;
      if (d && d.type === 'lb-updated') toast('已更新到新版本，下拉刷新即可应用');
    });
  } catch (e) {}
  try {
    const u = new URL('sw.js', location.href);
    const sc = sharecode();
    if (sc) u.searchParams.set('sharecode', sc);
    u.searchParams.set('v', window.__LB_BUILD__ || 'dev');
    navigator.serviceWorker.register(u.href, { scope: './', updateViaCache: 'none' })
      .catch(function (e) { console.warn('[sw] 注册跳过：' + ((e && e.message) || e)); });
  } catch (e) {}
}

/* ==================== 云客户端 ==================== */
let cloud = null, DB = null, cloudErr = '';
try {
  cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.APP_CONFIG.cloud.endpoint,
    oauthRelayBaseUrl: window.APP_CONFIG.cloud.oauthRelayBaseUrl,
    publishableKey: window.APP_CONFIG.cloud.publishableKey
  });
  DB = cloud.database;
} catch (e) {
  cloudErr = (e && e.message) || '云服务初始化失败';
  console.error('[cloud] init failed', cloudErr);
}
const q = async (p) => {
  const { data, error } = await p;
  if (error) throw error;
  return data;
};

/* ---- 登录态持久化（不设有效期） ------------------------------------------
   SDK 把会话存在 localStorage 的 workbuddy-cloud.session.<publishableKey>：里面有
   access_token（约 1 小时）和 refresh_token（SDK 会在到期前自动续期）。问题是
   iOS 会回收长期不用的脚本可写存储、用户清理网站数据也会连登录一起清掉，结果就是
   又要收一次验证码。所以把会话再镜像一份到第一方 cookie（Max-Age 取浏览器上限
   400 天），开机时本地存储空了就用 cookie 里的 refresh_token 复原，再交给 SDK 续期；
   每次打开/回前台都重写一次，等于滚动续期，实际不会过期。
   注意：cookie 里是账号凭证，只写 Path=/、SameSite=Lax、https 下加 Secure，
   退出登录时随会话一起删除。 */
const SESSION_KEY = 'workbuddy-cloud.session.' +
  ((window.APP_CONFIG && window.APP_CONFIG.cloud && window.APP_CONFIG.cloud.publishableKey) || '');
const SESSION_COOKIE = 'lb_session';
const SESSION_MAXAGE = 400 * 24 * 3600;      // 浏览器对 Max-Age 的上限就是 400 天

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
}
function writeCookie(name, value, maxAge) {
  if (!value) return;
  document.cookie = name + '=' + value + '; Path=/; Max-Age=' + maxAge +
    '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
}
function dropCookie(name) {
  document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax' +
    (location.protocol === 'https:' ? '; Secure' : '');
}
/* 只留续期与显示用户要用的字段，避免整串会话超过单条 cookie 4KB 上限 */
function slimSession(s) {
  const u = (s && s.user) || {};
  return {
    accessToken: String((s && s.accessToken) || ''),
    refreshToken: String((s && s.refreshToken) || ''),
    expiresAt: Number((s && s.expiresAt)) || 0,
    user: { id: u.id || '', name: u.name || '', avatarUrl: u.avatarUrl || '', isAnonymous: !!u.isAnonymous }
  };
}
function persistSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || !s.refreshToken) return false;
    const enc = encodeURIComponent(JSON.stringify(slimSession(s)));
    if (enc.length > 3900) { console.warn('[session] 会话过大，跳过 cookie 镜像'); return false; }
    writeCookie(SESSION_COOKIE, enc, SESSION_MAXAGE);
    return true;
  } catch (e) { return false; }
}
function restoreSession() {
  let cur = null;
  try { cur = localStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  if (cur) { persistSession(); return false; }        // 本地还在，顺手把 cookie 续期
  const raw = readCookie(SESSION_COOKIE);
  if (!raw) return false;
  let s = null;
  try { s = JSON.parse(decodeURIComponent(raw)); } catch (e) { return false; }
  if (!s || !s.refreshToken || !s.accessToken) return false;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(slimSession(s))); } catch (e) { return false; }
  return true;
}
/* 回前台就续一次 cookie：iOS 对脚本写 cookie 有 7 天回收，但只要打开过就一直续上 */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') persistSession();
});

/* ---- 写入可靠性 ----------------------------------------------------------
   云端在请求没带用户 JWT 时会以 owner_id='anon' 把 INSERT「成功」写进去，
   前端拿到 data 就以为保存成功；但随后的 SELECT 被 RLS 过滤，用户看到的是
   「已添加，刷新就没了」。所以每一条 insert 都要校验返回行的 owner。 */
function noteWriteError(act, e) {
  const rec = { at: new Date().toISOString(), act: act || '',
    message: String((e && e.message) || e || ''), owner: S.ownerId || '' };
  S.lastWriteError = rec;
  try { localStorage.setItem('lb.lastWriteError', JSON.stringify(rec)); } catch (x) {}
  return rec;
}
function assertOwner(row) {
  const o = row && row.owner_id;
  if (o === null || o === undefined) return;      // 该表/SDK 不回传 owner 时交给会话守卫
  const v = String(o);
  if (v === 'anon' || (S.ownerId && v !== S.ownerId)) {
    const e = new Error('写入被云端隔离：本次请求的账号与现有数据不一致，请重新登录后再试');
    e.needRelogin = true;
    throw e;
  }
}
async function insertRows(table, payload) {
  const rows = normRows(await q(DB.from(table).insert(payload).select()));
  if (!rows.length) throw new Error('云端未返回写入结果（可能被权限过滤）');
  rows.forEach(assertOwner);
  if (S.lastWriteError) {
    S.lastWriteError = null;
    try { localStorage.removeItem('lb.lastWriteError'); } catch (x) {}
  }
  return rows;
}
/* 写操作前的守卫：离线只读、会话失效都必须在写入之前明确告知，而不是静默拦掉 */
let sessionCheckedAt = 0;
async function writeGuard(act) {
  if (S.offline) {
    noteWriteError(act, new Error('离线只读模式，写入未发送到云端'));
    toast('当前是离线只读模式，这次操作没有写入云端。联网后刷新页面再试', null, 6000);
    return false;
  }
  if (!cloud || !cloud.auth) return true;
  if (Date.now() - sessionCheckedAt > 300000) {
    try {
      const r = await cloud.auth.getSession();
      const s = r && r.data;
      if (!s || (!s.access_token && !s.user)) {
        noteWriteError(act, new Error('登录状态已失效（未取得会话）'));
        showLogin('登录状态已失效，请重新登录后再写入');
        return false;
      }
      sessionCheckedAt = Date.now();
    } catch (e) { /* 探测失败不阻断写入，由 owner 校验兜底 */ }
  }
  return true;
}

/* ==================== 状态 ==================== */
const S = {
  user: null,
  view: 'today',
  habits: [],
  checkins: {},          // day -> { habitId: true }
  health: {},            // day -> row
  activities: [],
  books: [],
  notes: [],
  plans: [],
  logs: [],
  editing: false,
  filter: 'all',
  selDay: dayKey(new Date()),
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  range: 30,
  chartMode: 'rate',
  sparkField: null,
  libSec: 'lib-books',
  loading: false,
  offline: false,
  snapshotAt: null,
  loadAt: null,           // 上次「完整」从云端取数成功的时刻（快照时间戳取它，不取写入时刻）
  ownerId: null,          // 从云端读回的真实 owner，用于校验写入身份
  loadWarnings: 0,        // 本次加载失败的表数量
  loadFailed: [],         // 本次读取失败的表名（界面上要说清是哪块没更新）
  lastWriteError: null,   // 最近一次写入失败，「我的 → 数据健康」可见
  pending: {},            // 离线打卡队列：'day|habitId' -> 目标状态 true/false
  limitHit: false,        // 是否有表触达加载上限
  limits: { books: false, notes: false, activities: false, checkins: false },
  wereadKey: '',          // 微信读书 API Key（存 app_kv，受 RLS 保护）
  wereadSyncAt: null      // 上次书架同步时间
};

/* ==================== 图标 ==================== */
const P = {
  home: '<path d="M4 10.6 12 3.8l8 6.8V20a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 20z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.6h17M8 2.8v4M16 2.8v4"/>',
  book: '<path d="M4 19.4V5.2A2.2 2.2 0 0 1 6.2 3h12.6v18H6.2A2.2 2.2 0 0 0 4 21.2z"/><path d="M4 19.4A2.2 2.2 0 0 1 6.2 17.2h12.6"/>',
  pen: '<path d="M4 20h3.6L19 8.6a2.6 2.6 0 0 0-3.6-3.6L4 16.4z"/><path d="M14.6 6.4 17.6 9.4"/>',
  chart: '<path d="M4 19.4V4.6M4 19.4h16"/><path d="M7.6 15.4l3.6-4.2 3 2.6L19 7.4"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.6 20.2c0-3.7 3.3-5.7 7.4-5.7s7.4 2 7.4 5.7"/>',
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.6v2.1M12 19.3v2.1M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2.6 12h2.1M19.3 12h2.1M19.5 4.5 18 6M6 18l-1.5 1.5"/>',
  run: '<path d="M11 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 17l5 1l.75 -1.5"/><path d="M15 21v-4l-4 -3l1 -6"/><path d="M7 12v-3l5 -1l3 3l3 1"/>',
  med: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.8v4.6l2.6 2.2"/>',
  drop: '<path d="M12 3.2s6.2 6.6 6.2 10.6A6.2 6.2 0 0 1 5.8 13.8C5.8 9.8 12 3.2 12 3.2z"/>',
  bed: '<path d="M3 18.4v-6.2h18v6.2M3 12.2V6.4"/><path d="M6.8 12.2V9.5h5v2.7"/>',
  heart: '<path d="M12 20.2s-7.2-4.7-7.2-9.6A4 4 0 0 1 12 8a4 4 0 0 1 7.2 2.6c0 4.9-7.2 9.6-7.2 9.6z"/>',
  check: '<path d="M5 12.6 9.4 17 19 7.4"/>',
  plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  x: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  chev: '<path d="M9.2 5.6 15.4 12l-6.2 6.4"/>',
  left: '<path d="M14.8 5.6 8.6 12l6.2 6.4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20.4 4.2v4.6h-4.6"/>',
  link: '<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 0 0-5.1-5.1L11.9 7"/><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 0 0 5.1 5.1L12.1 17"/>',
  trash: '<path d="M4.8 6.6h14.4M9.4 6.6V4.6h5.2v2M6.6 6.6l.9 13.2a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-13.2"/>',
  bookop: '<path d="M12 6.4C10.4 4.8 8 4 5.4 4H3.2v14.2h2.2c2.6 0 5 .8 6.6 2.4"/><path d="M12 6.4c1.6-1.6 4-2.4 6.6-2.4h2.2v14.2h-2.2c-2.6 0-5 .8-6.6 2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/>',
  flame: '<path d="M12 21c3.6 0 6-2.4 6-5.6 0-4.2-4.4-5.4-4.4-9.4 0 0-2.6.8-2.6 4.2 0 1.4-1.2 2-2 1.2-.6-.6-.8-1.6-.8-1.6C6.6 11 6 13.2 6 15.4 6 18.6 8.4 21 12 21z"/>',
  scale: '<path d="M4.6 20.2V8.4M19.4 20.2V8.4"/><path d="M12 3.2v17"/><path d="M4.6 12.6h14.8"/>',
  moon: '<path d="M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a8.6 8.6 0 1 0 11 11z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  /* 运动图标统一采用 24×24 线性网格（Tabler Icons outline，MIT）；
     13–14px 小尺寸下只保留主轮廓，避免细节糊成一团。 */
  bike: '<path d="M2 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M16 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M12 19v-4l-3 -3l5 -4l2 3h3"/><path d="M13 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/>',
  swim: '<path d="M15 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M6 11l4 -2l3.5 3l-1.5 2"/><path d="M3 16.8c2 -1.4 4 -1.4 6 0s4 1.4 6 0s4 -1.4 6 0"/>',
  hike: '<path d="M3 20h18l-6.9 -14.6a2.3 2.3 0 0 0 -4.2 0l-6.9 14.6"/><path d="M7.5 11l2 2.5l2.5 -2.5l2 3l2.5 -2"/>',
  walk: '<path d="M12 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M7 21l3 -4"/><path d="M16 21l-2 -4l-3 -3l1 -6"/><path d="M6 12l2 -3l4 -1l3 3l3 1"/>',
  strength: '<path d="M4 10v4M6.5 8.5v7M17.5 8.5v7M20 10v4M6.5 12h11"/>',
  yoga: '<path d="M4 20h4l1.5 -3"/><path d="M17 20l-1 -5h-5l1 -7"/><path d="M4 10l4 -1l4 -1l4 1.5l4 1.5"/><path d="M10 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/>',
  row: '<path d="M3 16c3 -1.2 6 -1.2 9 0s6 1.2 9 0"/><path d="M3 20c3 -1.2 6 -1.2 9 0s6 1.2 9 0"/><path d="M6 12l11 -7"/>',
  sport: '<path d="M3 12h4l3 8l4 -16l3 8h4"/>'
};
function icon(name, size) {
  const d = P[name] || P.home;
  const s = size || 22;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" class="ic">' + d + '</svg>';
}

/* ==================== 离线快照 / 骨架屏 ==================== */
const SNAP_KEY = 'lb.snapshot.v1';
const SNAP_FIELDS = ['habits', 'checkins', 'health', 'activities', 'books', 'notes', 'plans', 'logs'];
/* 快照与离线队列都属于「某个账号」：换账号时必须丢弃，否则会看到上一个人的
   健康/打卡数据，甚至把上一个人的离线打卡按 habit_id 写进新账号。 */
function userId() {
  const u = S.user || {};
  return String(u.id || u.email || '') || '';
}
let snapMismatch = false;
function clearLocalData() {
  try {
    localStorage.removeItem(SNAP_KEY);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem('lb.lastWriteError');
    localStorage.removeItem(COROS_AUTO_KEY);
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('lb.draft.') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
  S.pending = {}; S.snapshotAt = null; S.loadAt = null; S.lastWriteError = null; S.ownerId = null;
  S.habits = []; S.checkins = {}; S.health = {}; S.activities = [];
  S.books = []; S.notes = []; S.plans = []; S.logs = [];
}
function saveSnapshot() {
  try {
    const data = {};
    SNAP_FIELDS.forEach(function (k) { data[k] = S[k]; });
    /* at 记的是「数据从云端取回的时刻」，不是「这次写盘的时刻」。
       否则写一次内容就把时间戳刷成现在，界面上的「数据更新于 X 小时前」
       会永远显示不出来，用户就失去判断「看到的是不是旧数据」的唯一线索。 */
    const at = S.loadAt || S.snapshotAt || new Date().toISOString();
    localStorage.setItem(SNAP_KEY, JSON.stringify({ at: at, data: data, owner: userId() }));
    S.snapshotAt = at;
  } catch (e) {}
}
/* 写入成功后也要刷新快照。
   只靠「加载成功时保存一次」是不够的：只要某次加载失败，界面就会回退到快照，
   刚写进去的内容看起来就像没保存（新增的打卡项消失、删掉的又回来）。
   这里让快照尽量等于「界面此刻显示的内容」，代价是一次防抖后的 localStorage 写入。
   没有成功加载做基底时（S.snapshotAt 为空）不写，避免用半成品覆盖掉可用的快照。 */
let snapSoonTimer = null;
function saveSnapshotSoon() {
  if (!S.snapshotAt || snapSoonTimer) return;
  snapSoonTimer = setTimeout(function () {
    snapSoonTimer = null;
    saveSnapshot();
  }, 400);
}
/* 页面被系统回收（iOS 切走即冻结、再回来可能是重开）时，上面 400ms 的防抖
   没落盘就等于没保存。隐藏/卸载前必须立刻写一次，否则「刚删的又回来」。 */
function flushSnapshotNow() {
  if (snapSoonTimer) { clearTimeout(snapSoonTimer); snapSoonTimer = null; }
  if (!S.user || !S.snapshotAt) return;
  saveSnapshot();
}
function readSnapshot() {
  try {
    const o = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    snapMismatch = false;
    if (!o || !o.data) return null;
    const me = userId();
    if (o.owner && me && String(o.owner) !== me) { snapMismatch = true; return null; }
    return o;
  } catch (e) { return null; }
}
function applySnapshot(snap, markOffline) {
  if (!snap || !snap.data) return false;
  SNAP_FIELDS.forEach(function (k) { if (snap.data[k] !== undefined) S[k] = snap.data[k]; });
  S.snapshotAt = snap.at;
  S.loadAt = snap.at;
  /* 快照是按账号隔离存的，可以直接把它当作「当前账号应为谁」：
     加载失败时也能继续用 owner 校验拦截写到别人的行（否则只能等下次加载才知道）。 */
  if (snap.owner && !S.ownerId) S.ownerId = String(snap.owner);
  if (markOffline !== false) S.offline = true;
  applyPending();
  bump();
  return true;
}

/* ---- 离线打卡队列 -------------------------------------------------------
   生活记录的使用场景常在户外/地铁：断网时不能让用户「记不了」。
   这里只把打卡做成可离线（目标状态幂等），其余写操作仍需联网并明确提示。 */
const PENDING_KEY = 'lb.pendingCheckins.v1';
function pendingKey(habitId, day) { return day + '|' + String(habitId); }
function pendingOf(habitId, day) { return S.pending[pendingKey(habitId, day)]; }
function savePending() {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(S.pending || {})); } catch (e) {}
}
function loadPending() {
  try {
    const o = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    S.pending = (o && typeof o === 'object') ? o : {};
  } catch (e) { S.pending = {}; }
}
function applyPending() {
  Object.keys(S.pending || {}).forEach(function (k) {
    const i = k.indexOf('|');
    if (i <= 0) return;
    const day = k.slice(0, i), hid = k.slice(i + 1);
    const m = S.checkins[day] = S.checkins[day] || {};
    if (S.pending[k]) m[hid] = true; else delete m[hid];
  });
}
function renderSkeleton(view) {
  const line = w => '<div class="sk-line sk-anim" style="width:' + w + '"></div>';
  const row = w => '<div class="sk-row"><div class="sk-dot sk-anim"></div>' +
    '<div class="sk-bar sk-anim" style="flex:1;max-width:' + w + '"></div></div>';
  const html = '<div class="sk-wrap">' + line('36%') + line('58%') +
    '<div class="sk-card"><div class="sk-bar sk-anim" style="width:62%;height:18px;margin-bottom:14px"></div>' +
    row('78%') + row('64%') + row('82%') + '</div>' +
    '<div class="sk-card">' + row('70%') + row('86%') + '</div></div>';
  const el = $('#view-' + (view || S.view || 'today'));
  if (el) { el.innerHTML = html; el.hidden = false; }
}

/* ==================== 数据层 ==================== */
const T = () => (window.__t || 0);
function bump() { window.__t = Date.now(); }

/* 所有从 DB 取回的实体统一把 id / 外键转成字符串，杜绝 number vs string 的 === 失配 */
function normRow(r) {
  if (!r || typeof r !== 'object') return r;
  const o = Object.assign({}, r);
  ['id', 'habit_id', 'book_id', 'plan_id'].forEach(k => {
    if (o[k] !== null && o[k] !== undefined) o[k] = String(o[k]);
  });
  return o;
}
const normRows = rows => (rows || []).map(normRow);

/* 书架/划线/运动设上限：个人库足够用，避免无界增长把首屏拖慢；完整数据仍可全量导出。
   checkins 不设上限而是分页取全 —— 它决定历史完成率与热力图，缺行会直接算错。 */
const LOAD_LIMITS = { books: 1000, notes: 3000, activities: 200, checkins: 6000 };
/* loadAll 里 Promise.allSettled 的顺序，用来把失败项翻译成表名 */
const LOAD_TABLES = ['habits', 'checkins', 'health_daily', 'activities',
                     'books', 'notes', 'study_plans', 'study_logs'];
/* 表名 → 界面上对用户有意义的叫法，用于「哪块数据没更新」的提示 */
const LOAD_LABELS = { habits: '打卡项', checkins: '打卡记录', health_daily: '身体数据',
                      activities: '运动记录', books: '书架', notes: '划线',
                      study_plans: '学习计划', study_logs: '学习记录' };
const PAGE_SIZE = 500;
/* 分页取全：服务端可能对单次响应设了行数上限，一次 select 拿不全就会被静默截断。
   每页用 range 取，取到不足一页即认为到底；累计到 cap 仍未到底则标记 truncated。 */
async function selectPaged(table, build, cap, cols) {
  const rows = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    let b = DB.from(table).select(cols || '*');
    if (build) b = build(b);
    const part = await q(b.order('id').range(from, from + PAGE_SIZE - 1));
    if (!part || !part.length) return { rows: rows, truncated: false };
    rows.push.apply(rows, part);
    if (part.length < PAGE_SIZE) return { rows: rows, truncated: false };
  }
  return { rows: rows, truncated: true };
}
async function loadAll() {
  if (!DB) throw new Error('云服务未就绪');
  const since = dayKey(addDays(new Date(), -400));
  const ck = selectPaged('checkins', b => b.gte('day', since), LOAD_LIMITS.checkins, 'habit_id,day')
    .catch(e => ({ rows: null, truncated: false, error: e }));
  /* 逐表容错：任何一张表查询失败都不该把整个页面打成「离线只读」，
     否则用户看到缓存数据却写不进去，且没有任何明确原因。 */
  const rs = await Promise.allSettled([
    q(DB.from('habits').select('*').order('sort_order').order('id')),
    ck,
    q(DB.from('health_daily').select('*').gte('day', since).order('day')),
    q(DB.from('activities').select('*').gte('day', since).order('day', { ascending: false }).limit(LOAD_LIMITS.activities)),
    q(DB.from('books').select('*').order('created_at', { ascending: false }).limit(LOAD_LIMITS.books)),
    q(DB.from('notes').select('*').order('created_at', { ascending: false }).limit(LOAD_LIMITS.notes)),
    q(DB.from('study_plans').select('*').order('sort_order').order('id')),
    q(DB.from('study_logs').select('*').gte('day', since).order('day', { ascending: false }))
  ]);
  const at = i => rs[i].status === 'fulfilled' ? (rs[i].value || null) : null;
  const ckResEarly = at(1);
  const failed = rs.filter(r => r.status === 'rejected').length + (ckResEarly && ckResEarly.error ? 1 : 0);
  /* 记下具体是哪几张表没读到：界面要明确告诉用户「打卡项没更新」，
     而不是让他面对一份看起来正常、其实是旧缓存的数据。 */
  S.loadFailed = rs.map((r, i) => {
    const bad = r.status === 'rejected' || (i === 1 && ckResEarly && ckResEarly.error);
    return bad ? LOAD_TABLES[i] : null;
  }).filter(Boolean);
  if (failed >= rs.length) {
    const firstRej = rs.find(r => r.status === 'rejected');
    throw ((ckResEarly && ckResEarly.error) || (firstRej && firstRej.reason) || new Error('数据加载失败'));
  }
  S.loadWarnings = failed;
  /* 只有「八张表全部读到了」才算一次可信的取数：部分失败时界面里还有旧内容，
     这时候刷新时间戳会把「数据其实是旧的」掩盖掉，宁可保守地不更新。 */
  if (!failed) S.loadAt = new Date().toISOString();
  const habits = at(0), ckRes = at(1), health = at(2), acts = at(3),
        books = at(4), notes = at(5), plans = at(6), logs = at(7);
  const checkins = ckRes ? ckRes.rows : null;
  // habits / plans 保留 archived 记录：计算历史分母需要它们，UI 再用 activeXxx() 过滤
  if (habits) S.habits = normRows(habits);
  if (checkins) {
    S.checkins = {};
    checkins.forEach(r => {
      const d = String(r.day).slice(0, 10);
      (S.checkins[d] = S.checkins[d] || {})[String(r.habit_id)] = true;
    });
  }
  if (health) {
    S.health = {};
    health.forEach(r => { S.health[String(r.day).slice(0, 10)] = r; });
  }
  if (acts) S.activities = normRows(acts);
  if (books) S.books = normRows(books);
  if (notes) S.notes = normRows(notes);
  if (plans) S.plans = normRows(plans);
  if (logs) S.logs = normRows(logs);
  /* 触达上限的表现在明确告知，而不是静默少显示 */
  S.limits = {
    books: (books || []).length >= LOAD_LIMITS.books,
    notes: (notes || []).length >= LOAD_LIMITS.notes,
    activities: (acts || []).length >= LOAD_LIMITS.activities,
    checkins: !!(ckRes && ckRes.truncated)
  };
  S.limitHit = S.limits.books || S.limits.notes || S.limits.activities || S.limits.checkins;
  applyPending();                 // 云端数据回来后，仍在队列里的离线打卡不能被覆盖掉
  const probe = [].concat(habits || [], health || [], acts || [], books || [],
    notes || [], plans || [], logs || []).find(r => r && r.owner_id);
  if (probe) S.ownerId = String(probe.owner_id);
  S.offline = false;              // 加载成功即解除离线态，避免闩死
  bump();
}

/* 当日有效习惯快照：用 created_at / archived_at 还原当天实际存在的习惯，
   增删习惯不再改写历史热力图、趋势与相关系数。 */
function activeHabits() { return S.habits.filter(h => !h.archived); }
function activeBooks() { return S.books.filter(b => !b.deleted_at); }
function activeNotes() { return S.notes.filter(n => !n.deleted_at); }
function activePlans() { return S.plans.filter(p => !p.archived && !p.deleted_at); }
function dayEndTs(day) { return new Date(day + 'T23:59:59').getTime(); }
function habitsForDay(day) {
  const t = dayEndTs(day);
  return S.habits.filter(h => {
    const born = h.created_at ? new Date(h.created_at).getTime() : 0;
    if (born > t) return false;
    if (h.archived) {
      const gone = h.archived_at ? new Date(h.archived_at).getTime() : 0;
      if (gone <= t) return false;
    }
    return true;
  });
}
function isDone(habitId, day) {
  const m = S.checkins[day];
  return !!(m && m[String(habitId)]);
}
function dayEntries(day) { return habitsForDay(day).length; }
function doneCount(day) {
  return habitsForDay(day).reduce((n, h) => n + (isDone(h.id, day) ? 1 : 0), 0);
}
function rateOfDay(day) {
  const n = dayEntries(day);
  return n ? doneCount(day) / n : null;   // 当天没有有效习惯 = 无数据，不是 0%
}
function hasCheckins(day) {
  const m = S.checkins[day];
  return !!(m && Object.keys(m).length);
}

async function toggleCheckin(habitId, day, skipRender) {
  const on = isDone(habitId, day);
  const m = S.checkins[day] = S.checkins[day] || {};
  const key = pendingKey(habitId, day);
  const want = !on;
  if (on) delete m[String(habitId)]; else m[String(habitId)] = true;

  /* 离线也能打卡：目标状态入队，联网后幂等回放 */
  if (S.offline || navigator.onLine === false) {
    S.pending[key] = want;
    savePending();
    if (!skipRender) render(); else renderChrome();
    toast(want ? '已记录，联网后自动同步' : '已取消，联网后自动同步', null, 2800);
    return;
  }

  if (!skipRender) render();
  if (S.pending[key] !== undefined) { delete S.pending[key]; savePending(); }
  try {
    if (on) {
      await q(DB.from('checkins').delete().eq('habit_id', dbId(habitId)).eq('day', day).select());
    } else {
      await insertRows('checkins', { habit_id: dbId(habitId), day: day });
    }
  } catch (e) {
    const net = navigator.onLine === false ||
      /failed to fetch|network|timeout|load failed|offline/i.test(String(e.message || ''));
    if (net) {
      // 网络抖动时不回滚，先落到本机队列，避免用户刚点的记录白丢
      S.pending[key] = want;
      savePending();
      toast('网络中断，已暂存本机，联网后自动同步', null, 6000);
    } else {
      if (on) m[String(habitId)] = true; else delete m[String(habitId)];
      noteWriteError('toggle', e);
      toast('保存失败：' + (e.message || '网络异常'), null, 6000);
    }
    if (!skipRender) render();
  }
  /* 打卡走 patchCheckinUI 局部刷新，不会触发 render，这里补一次快照刷新 */
  saveSnapshotSoon();
}

async function saveHabit(payload, id) {
  if (id != null && id !== '') {
    const row = await patchRow('habits', id, payload, '这个打卡项');
    const i = S.habits.findIndex(h => eqId(h.id, id));
    if (i >= 0) S.habits[i] = Object.assign(S.habits[i], row);
  } else {
    const rows = await insertRows('habits', payload);
    /* 写后回读：确认这行对当前账号可见，杜绝「提示已添加、刷新就没了」 */
    const back = await q(DB.from('habits').select('id').eq('id', dbId(rows[0].id)).limit(1));
    if (!back || !back.length) {
      const e = new Error('写入后无法读回该打卡项（可能被账号权限隔离），请重新登录后再试');
      e.needRelogin = true;
      throw e;
    }
    if (!S.ownerId && rows[0].owner_id) S.ownerId = String(rows[0].owner_id);
    S.habits.push(rows[0]);
  }
  render();
}

/* 软删除：保留习惯与其历史打卡，历史完成率才不会因删项而被改写。
   先确认云端真的改了这一行再改内存，否则「删掉→刷新又回来」。 */
async function removeHabit(id) {
  const at = new Date().toISOString();
  const row = await patchRow('habits', id, { archived: true, archived_at: at }, '这个打卡项');
  const h = S.habits.find(x => eqId(x.id, id));
  if (h) { h.archived = true; h.archived_at = at; }
  else if (row) S.habits.push(row);
  render();
}

async function saveBook(payload) {
  try {
    const rows = await insertRows('books', payload);
    if (!rows.length) throw new Error('未能添加书籍');
    S.books.unshift(rows[0]);
    render();
    return rows[0];
  } catch (e) {
    /* DB 侧有 (owner_id, external_id) 与 (owner_id, lower(title)) 两条唯一索引：
       并发或旧数据重名时会撞 23505，翻译成人话而不是把 SQL 错误抛给用户 */
    if (/duplicate key|unique constraint|23505/i.test(String((e && e.message) || ''))) {
      const dup = new Error('这本已经在书架里了');
      dup.duplicateBook = true;
      throw dup;
    }
    throw e;
  }
}
/* 软删除：书籍与它的划线共用一个时间戳，恢复时能精确还原这一批 */
async function removeBook(id) {
  const at = new Date().toISOString();
  await patchRow('books', id, { deleted_at: at }, '这本书');
  /* 只按 id 逐条更新：避免依赖 SDK 对 eq(col, null) / is() 的支持差异。
     单条划线没被确认不拖垮整本删除（书已删，划线本来也不再显示），
     但没被确认的那条不改内存，避免「界面删了、云端还在」。 */
  const noteIds = S.notes.filter(n => eqId(n.book_id, id) && !n.deleted_at).map(n => n.id);
  const done = {};
  for (const nid of noteIds) {
    try { await patchRow('notes', nid, { deleted_at: at }, '这条划线'); done[dbId(nid)] = true; }
    catch (e) { noteWriteError('removeBookNote', e); }
  }
  const b = S.books.find(x => eqId(x.id, id));
  if (b) b.deleted_at = at;
  S.notes.forEach(n => { if (done[dbId(n.id)]) n.deleted_at = at; });
  render();
}
async function patchBook(id, payload) {
  const row = await patchRow('books', id, payload, '这本书');
  const i = S.books.findIndex(b => eqId(b.id, id));
  if (i >= 0) Object.assign(S.books[i], row);
  render();
}

/* 逐条写入：DB 侧 (owner_id, book_id, md5(content)) 唯一索引兜底，
   同一次粘贴里的重复、以及重复导入都会被跳过而不是静默造重复数据。 */
async function addNotes(list) {
  let added = 0, skipped = 0;
  for (const row of list) {
    if (S.notes.some(n => !n.deleted_at && eqId(n.book_id, row.book_id) && n.content === row.content)) { skipped++; continue; }
    try {
      const rows = await insertRows('notes', row);
      if (rows[0]) { S.notes.push(rows[0]); added++; } else skipped++;
    } catch (e) {
      if (/duplicate|unique|23505|conflict/i.test(e.message || '')) skipped++;
      else throw e;
    }
  }
  render();
  return { added: added, skipped: skipped };
}
async function removeNote(id) {
  const at = new Date().toISOString();
  await patchRow('notes', id, { deleted_at: at }, '这条划线');
  const n = S.notes.find(x => eqId(x.id, id));
  if (n) n.deleted_at = at;
  render();
}

async function savePlan(payload) {
  const rows = await insertRows('study_plans', payload);
  if (!rows.length) throw new Error('未能创建计划');
  S.plans.push(rows[0]); render();
}
async function removePlan(id) {
  const at = new Date().toISOString();
  await patchRow('study_plans', id, { deleted_at: at }, '这个计划');
  const p = S.plans.find(x => eqId(x.id, id));
  if (p) p.deleted_at = at;
  render();
}
function loggedToday(planId, day) {
  const d = day || TODAY();
  return S.logs.some(l => eqId(l.plan_id, planId) && String(l.day).slice(0, 10) === d);
}
/* 每天每个计划只记一次：前端拦截连点，DB 侧 (owner_id, plan_id, day) 唯一索引兜底 */
async function logStudy(planId) {
  const today = TODAY();
  if (loggedToday(planId, today)) { toast('今天已经记过一次了'); return false; }
  let rows;
  try {
    rows = await insertRows('study_logs', { plan_id: dbId(planId), day: today });
  } catch (e) {
    if (/duplicate|unique|23505|conflict/i.test(e.message || '')) { toast('今天已经记过一次了'); return false; }
    throw e;
  }
  if (!rows.length) throw new Error('未能记录');
  S.logs.unshift(rows[0]);
  render();
  toast('已记录一次');
  return true;
}

/* 幂等写入：DB 的 day 是 date 列，经 SDK 返回 ISO 串（2026-11-08T00:00:00Z），
   用 .eq('day','2026-11-08') 查不到已有行，重复同步会 INSERT 撞 (owner_id, day) 唯一键。
   因此优先用 loadAll 已读入内存的 id；没有则无条件拉表、在 JS 侧按前 10 位匹配；
   INSERT 仍撞唯一键时再查一次改 UPDATE，绝不因重复同步中断整轮。 */
function isDupError(e) {
  const s = String((e && (e.message || e.details || e.hint)) || e || '').toLowerCase();
  return s.indexOf('duplicate') >= 0 || s.indexOf('unique constraint') >= 0 || s.indexOf('23505') >= 0;
}
async function findRowId(table, col, val, len) {
  const n = len || 10;
  let rows = null;
  /* date 列在服务端做范围过滤，避免每次同步都全表拉一遍 */
  if (n === 10 && /^\d{4}-\d{2}-\d{2}$/.test(String(val))) {
    try { rows = await q(DB.from(table).select('id,' + col).gte(col, val).lte(col, val)); }
    catch (e) { rows = null; }
  }
  if (!rows) rows = await q(DB.from(table).select('id,' + col));
  const hit = (rows || []).find(r => String(r[col]).slice(0, n) === val);
  return hit ? dbId(hit.id) : null;
}
/* UPDATE ... select() 返回 0 行，说明云端一行都没改动（被 RLS 过滤、已被别的设备
   删掉、或这行不属于当前账号）。此时若照样改内存，界面会显示「已删除」，下次加载
   又把它拉回来 —— 正是「删了、刷新又变回原样」。所以要求必须有确认行，没有就报错。 */
async function patchRow(table, id, payload, what) {
  const rows = normRows(await q(DB.from(table).update(payload).eq('id', dbId(id)).select()));
  if (!rows.length) {
    const e = new Error('云端没有确认这次修改（' + (what || '这条记录') + '可能已被删除，或不属于当前账号），请刷新后重试');
    e.notConfirmed = true;
    throw e;
  }
  return rows[0];
}
async function patchById(table, id, payload) {
  await patchRow(table, id, payload, '这条记录');
}

/* 回放离线打卡：目标状态幂等（true=INSERT、false=DELETE），重复写入视为已同步 */
async function flushPending() {
  if (!DB || !S.user || S.offline || navigator.onLine === false) {
    return { ok: 0, left: Object.keys(S.pending || {}).length };
  }
  const keys = Object.keys(S.pending || {});
  if (!keys.length) return { ok: 0, left: 0 };
  let ok = 0;
  for (const k of keys) {
    const i = k.indexOf('|');
    if (i <= 0) { delete S.pending[k]; continue; }
    const day = k.slice(0, i), hid = k.slice(i + 1);
    const want = !!S.pending[k];
    try {
      if (want) {
        try { await insertRows('checkins', { habit_id: dbId(hid), day: day }); }
        catch (e) { if (!isDupError(e)) throw e; }
      } else {
        await q(DB.from('checkins').delete().eq('habit_id', dbId(hid)).eq('day', day).select());
      }
      delete S.pending[k]; ok++;
    } catch (e) {
      noteWriteError('flushCheckin', e);
      break;                              // 失败即停，下次联网重试，避免雪崩
    }
  }
  savePending();
  /* 只负责把队列刷进云端，不在这里重载：重载由调用方串行安排，
     否则和紧随其后的 loadAll 撞在一起会重复拉全量、重复弹 toast。 */
  if (ok) toast('已同步 ' + ok + ' 项离线打卡');
  return { ok: ok, left: Object.keys(S.pending || {}).length };
}

async function upsertHealth(day, patch) {
  const clean = {};
  Object.keys(patch || {}).forEach(k => { if (patch[k] !== null && patch[k] !== undefined) clean[k] = patch[k]; });
  if (!Object.keys(clean).length) return;
  const cur = S.health[day];
  let id = cur && cur.id !== null && cur.id !== undefined ? dbId(cur.id) : null;
  if (id === null) id = await findRowId('health_daily', 'day', day, 10);
  const payload = Object.assign({}, clean, { updated_at: new Date().toISOString() });
  if (id !== null) {
    await patchById('health_daily', id, payload);
  } else {
    try {
      const rows = await insertRows('health_daily', Object.assign({ day: day }, clean));
      if (rows && rows[0]) id = dbId(rows[0].id);
    } catch (e) {
      if (!isDupError(e)) throw e;
      const again = await findRowId('health_daily', 'day', day, 10);
      if (again !== null) { id = again; await patchById('health_daily', id, payload); }
      else await q(DB.from('health_daily').update(payload).eq('day', day).select());
    }
  }
  S.health[day] = Object.assign(S.health[day] || { day: day }, clean, id !== null ? { id: String(id) } : {});
  /* 这一类写入（COROS 同步）不经过 render，调用方若在之后卡住/失败，
     快照就会停在同步前的样子；由写入方自己负责把快照标脏。 */
  saveSnapshotSoon();
}

async function upsertActivity(row) {
  if (!row || !row.external_id) return;
  const ext = String(row.external_id);
  let cur = (S.activities || []).find(a => String(a.external_id) === ext);
  let id = cur && cur.id !== null && cur.id !== undefined ? dbId(cur.id) : null;
  if (id === null) {
    try {
      const rows = await q(DB.from('activities').select('id,external_id').eq('external_id', ext).limit(1));
      if (rows && rows[0]) id = dbId(rows[0].id);
    } catch (e) {
      const rows = await q(DB.from('activities').select('id,external_id'));
      const hit = (rows || []).find(r => String(r.external_id) === ext);
      if (hit) id = dbId(hit.id);
    }
  }
  if (id !== null) {
    await patchById('activities', id, row);
    if (cur) Object.assign(cur, row);
    saveSnapshotSoon();                 // 同 upsertHealth：写入方自己负责标脏快照
    return;
  }
  try {
    const rows = await insertRows('activities', row);
    const saved = rows && rows[0] ? rows[0] : null;
    if (saved) S.activities.push(saved);
  } catch (e) {
    if (!isDupError(e)) throw e;
    let hit = null;
    try {
      const rows = await q(DB.from('activities').select('id,external_id').eq('external_id', ext).limit(1));
      hit = rows && rows[0];
    } catch (e2) {
      const rows = await q(DB.from('activities').select('id,external_id'));
      hit = (rows || []).find(r => String(r.external_id) === ext);
    }
    if (hit) { const rid = dbId(hit.id); await patchById('activities', rid, row); S.activities.push(normRow(Object.assign({ id: rid }, row))); }
    else await q(DB.from('activities').update(row).eq('external_id', ext).select());
  }
  saveSnapshotSoon();
}

async function kvGet(k) {
  const rows = await q(DB.from('app_kv').select('*').eq('k', k).limit(1));
  return rows && rows[0] ? rows[0].v : null;
}
async function kvSet(k, v) {
  const rows = await q(DB.from('app_kv').select('id').eq('k', k).limit(1));
  if (rows && rows[0]) {
    await patchRow('app_kv', rows[0].id, { v: v, updated_at: new Date().toISOString() }, '这个设置项');
  } else {
    await insertRows('app_kv', { k: k, v: v });
  }
}
async function kvDel(k) {
  await q(DB.from('app_kv').delete().eq('k', k).select());
}

/* ==================== 最近删除与恢复 ==================== */
async function restoreRow(kind, id) {
  if (kind === 'habit') {
    await patchRow('habits', id, { archived: false, archived_at: null }, '这个打卡项');
    const h = S.habits.find(x => eqId(x.id, id));
    if (h) { h.archived = false; h.archived_at = null; }
  } else if (kind === 'book') {
    const b = S.books.find(x => eqId(x.id, id));
    const stamp = b ? b.deleted_at : null;
    await patchRow('books', id, { deleted_at: null }, '这本书');
    if (b) {
      b.deleted_at = null;
      const ids = S.notes.filter(n => eqId(n.book_id, id) && stamp && n.deleted_at === stamp).map(n => n.id);
      for (const nid of ids) {
        try {
          await patchRow('notes', nid, { deleted_at: null }, '这条划线');
          const n = S.notes.find(x => eqId(x.id, nid));
          if (n) n.deleted_at = null;
        } catch (e) { noteWriteError('restoreBookNote', e); }
      }
    }
  } else if (kind === 'note' || kind === 'plan') {
    const t = kind === 'note' ? 'notes' : 'study_plans';
    await patchRow(t, id, { deleted_at: null }, kind === 'note' ? '这条划线' : '这个计划');
    const row = (kind === 'note' ? S.notes : S.plans).find(x => eqId(x.id, id));
    if (row) row.deleted_at = null;
  }
  render();
}
function fmtStamp(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function recentDeleted() {
  const list = [];
  S.habits.filter(h => h.archived).forEach(h =>
    list.push({ kind: 'habit', id: h.id, label: h.name, type: '打卡项', at: h.archived_at }));
  S.books.filter(b => b.deleted_at).forEach(b =>
    list.push({ kind: 'book', id: b.id, label: b.title, type: '书籍', at: b.deleted_at }));
  S.notes.filter(n => n.deleted_at).forEach(n =>
    list.push({ kind: 'note', id: n.id, label: (n.content || '').slice(0, 18), type: '划线', at: n.deleted_at }));
  S.plans.filter(p => p.deleted_at).forEach(p =>
    list.push({ kind: 'plan', id: p.id, label: p.title, type: '学习计划', at: p.deleted_at }));
  return list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 20);
}
function openTrashSheet() {
  const list = recentDeleted();
  const body = list.length
    ? '<div class="card">' + list.map(x =>
        '<div class="rowbtn" style="cursor:default"><div style="flex:1;min-width:0">' +
        '<div class="rb-t">' + esc(x.label || '(未命名)') + '</div>' +
        '<div class="rb-s">' + esc(x.type) + ' · ' + esc(fmtStamp(x.at)) + '</div></div>' +
        '<button class="pill" data-act="restore" data-kind="' + x.kind + '" data-id="' + x.id + '">恢复</button></div>').join('') + '</div>'
    : '<div class="empty">最近没有删除的内容。</div>';
  openSheet('<div class="grabber"></div><div class="sheet-h"><div class="t">最近删除</div>' +
    '<button data-act="closesheet">关闭</button></div><div class="sheet-body">' +
    '<div class="gfoot" style="margin:0 4px 12px">删除的内容仍保留在云端，可在这里恢复；也可以导出备份另存。</div>' +
    body + '</div>');
}

/* ==================== 导出 / 导入备份 ==================== */
const BACKUP_TABLES = ['habits', 'checkins', 'health_daily', 'activities', 'books',
  'notes', 'study_plans', 'study_logs', 'app_kv'];
/* 凭据类 KV 不进备份、也不从备份导入：COROS 令牌、微信读书 API Key 等 */
const SENSITIVE_KV = /(^coros|key|token|secret|password|auth)/i;
const BACKUP_CAP = 20000;     // 单表硬上限：超出即标记 truncated，绝不静默少导
async function fetchBackupRows() {
  if (S.offline) {
    const ck = [];
    Object.keys(S.checkins).forEach(function (d) {
      Object.keys(S.checkins[d]).forEach(function (h) { ck.push({ habit_id: h, day: d }); });
    });
    const tables = {
      habits: S.habits, checkins: ck,
      health_daily: Object.keys(S.health).map(d => Object.assign({ day: d }, S.health[d])),
      activities: S.activities, books: S.books, notes: S.notes,
      study_plans: S.plans, study_logs: S.logs, app_kv: []
    };
    const counts = {};
    Object.keys(tables).forEach(k => { counts[k] = (tables[k] || []).length; });
    return { tables: tables, counts: counts, truncated: [] };
  }
  /* 全量导出必须分页：单次 select 可能被服务端行数上限截断，而用户以为拿到的是全部 */
  const tables = {}, counts = {}, truncated = [];
  for (const t of BACKUP_TABLES) {
    const res = await selectPaged(t, null, BACKUP_CAP);
    let rows = normRows(res.rows);
    // 凭据（COROS 令牌、微信读书 Key 等）不写进备份文件
    if (t === 'app_kv') rows = rows.filter(r => !SENSITIVE_KV.test(String(r.k)));
    tables[t] = rows;
    counts[t] = rows.length;
    if (res.truncated) truncated.push(t);
  }
  return { tables: tables, counts: counts, truncated: truncated };
}
async function exportBackup() {
  const res = await fetchBackupRows();
  const total = Object.keys(res.counts).reduce((n, k) => n + res.counts[k], 0);
  const payload = { app: 'life-dashboard', version: 1, exported_at: new Date().toISOString(),
    tables: res.tables, counts: res.counts };
  const json = JSON.stringify(payload, null, 2);
  const name = '生活记录备份-' + TODAY() + '.json';
  try {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {}
  try { localStorage.setItem('lb.last_export', new Date().toISOString()); } catch (e) {}
  toast(res.truncated.length
    ? '已导出 ' + total + ' 行；' + res.truncated.join('、') + ' 超过单表上限，备份不完整'
    : '已导出 ' + total + ' 行（已排除授权令牌与 API Key）');
  return { name: name, json: json, tables: res.tables, counts: res.counts, truncated: res.truncated };
}
/* 合并式恢复：已存在的行只补齐软删除状态，缺失的行按外键映射后追加；绝不覆盖现有数据 */
async function restoreBackup(payload) {
  if (!payload || payload.app !== 'life-dashboard' || !payload.tables) throw new Error('不是有效的备份文件');
  const order = ['habits', 'books', 'study_plans', 'health_daily', 'activities',
    'checkins', 'notes', 'study_logs', 'app_kv'];
  const fk = { checkins: ['habit_id', 'habits'], notes: ['book_id', 'books'], study_logs: ['plan_id', 'study_plans'] };
  const idMap = {}; order.forEach(t => { idMap[t] = {}; });
  let added = 0, restored = 0, skipped = 0;
  for (const t of order) {
    let cur = [];
    try { cur = normRows(await q(DB.from(t).select('*'))); } catch (e) { continue; }
    const byId = new Map(cur.map(r => [String(r.id), r]));
    for (const raw of (payload.tables[t] || [])) {
      const oldId = String(raw.id);
      const exist = byId.get(oldId);
      if (exist) {
        idMap[t][oldId] = dbId(exist.id);
        const revive = {};
        if (exist.deleted_at && !raw.deleted_at) revive.deleted_at = null;
        if (exist.archived && !raw.archived) { revive.archived = false; revive.archived_at = null; }
        if (Object.keys(revive).length) {
          try { await q(DB.from(t).update(revive).eq('id', dbId(exist.id)).select()); restored++; }
          catch (e) { skipped++; }
        } else skipped++;
        continue;
      }
      const row = Object.assign({}, raw);
      delete row.id; delete row.owner_id;
      if (fk[t]) {
        const mapped = idMap[fk[t][1]][String(row[fk[t][0]])];
        if (mapped === undefined) { skipped++; continue; }
        row[fk[t][0]] = mapped;
      }
      if (t === 'app_kv' &&
          (SENSITIVE_KV.test(String(row.k)) || cur.some(r => String(r.k) === String(row.k)))) { skipped++; continue; }
      try {
        const ins = await insertRows(t, row);
        if (ins[0]) { idMap[t][oldId] = dbId(ins[0].id); cur.push(ins[0]); added++; }
        else skipped++;
      } catch (e) { noteWriteError('importbackup', e); skipped++; }
    }
  }
  await loadAll(); saveSnapshot(); render();
  return { added: added, restored: restored, skipped: skipped };
}

/* ==================== 主题 ==================== */
function applyTheme(mode, silent) {
  document.documentElement.setAttribute('data-theme', mode);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#F2F2F7' : '#000000');
  try { localStorage.setItem('lifeboard.theme', mode); } catch (e) {}
  const sw = document.getElementById('sw-theme');
  if (sw) sw.classList.toggle('on', mode === 'dark');
  if (!silent) toast(mode === 'dark' ? '已切换为深色' : '已切换为浅色');
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'light' ? 'dark' : 'light');
}

/* 液态玻璃：默认开启，用户可在「我的 → 外观」关闭；偏好存本地，与主题独立 */
const GLASS_KEY = 'lifeboard.glass';
function glassOn() {
  try { return localStorage.getItem(GLASS_KEY) !== 'off'; } catch (e) { return true; }
}
function applyGlass(on, silent) {
  document.documentElement.setAttribute('data-glass', on ? 'on' : 'off');
  try { localStorage.setItem(GLASS_KEY, on ? 'on' : 'off'); } catch (e) {}
  const sw = document.getElementById('sw-glass');
  if (sw) sw.classList.toggle('on', !!on);
  if (!silent) toast(on ? '已开启液态玻璃' : '已关闭液态玻璃');
}
function toggleGlass() {
  applyGlass(document.documentElement.getAttribute('data-glass') !== 'on');
}
/* 桌面端让镜面高光跟随指针；触屏设备由 CSS 的 glassLight 动画接管 */
function initGlassLight() {
  const fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!fine) return;
  const root = document.documentElement;
  let raf = 0, last = null;
  window.addEventListener('pointermove', function (e) {
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      if (!last) return;
      root.style.setProperty('--gx', (last.clientX / window.innerWidth * 100).toFixed(1) + '%');
      root.style.setProperty('--gy', (last.clientY / window.innerHeight * 100).toFixed(1) + '%');
    });
  }, { passive: true });
}

/* ==================== 通用片段 ==================== */
const TABS = [
  { k: 'today', n: '今日', i: 'home' },
  { k: 'calendar', n: '日历', i: 'calendar' },
  { k: 'library', n: '学习', i: 'book' },
  { k: 'trend', n: '趋势', i: 'chart' }
];
const VIEWS = ['today', 'calendar', 'library', 'trend', 'me'];
const TITLES = { today: '今日', calendar: '日历', library: '学习', trend: '趋势', me: '我的' };
/* 旧版把阅读、学习拆成两页：离线快照 / 旧链接里的 view 值统一落到合并页 */
const VIEW_ALIAS = { reading: 'library', study: 'library' };

let chromeCache = { tabbar: '', snav: '' };
function renderChrome() {
  /* 只在内容真的变化时重建，否则同一视图内的操作会把焦点从标签栏上打掉 */
  const tb = TABS.map(t =>
    '<button class="tab' + (S.view === t.k ? ' on' : '') + '" data-act="tab" data-id="' + t.k + '">' +
    icon(t.i, 21) + '<span>' + t.n + '</span></button>').join('');
  if (tb !== chromeCache.tabbar) { $('#tabbar').innerHTML = tb; chromeCache.tabbar = tb; }
  // 桌面侧栏保留「我的」入口；移动端走右上角头像按钮
  const sn = TABS.map(t =>
    '<button class="' + (S.view === t.k ? 'on' : '') + '" data-act="tab" data-id="' + t.k + '">' +
    icon(t.i, 18) + '<span>' + t.n + '</span></button>').join('') +
    '<div class="side-sep"></div>' +
    '<button class="' + (S.view === 'me' ? 'on' : '') + '" data-act="tab" data-id="me">' +
    icon('person', 18) + '<span>我的</span></button>';
  if (sn !== chromeCache.snav) { $('#snav').innerHTML = sn; chromeCache.snav = sn; }
  $('#nav-title').textContent = TITLES[S.view] || '';
  const bm = $('#btn-me');
  if (bm) bm.classList.toggle('on', S.view === 'me');
  const ob = $('#offline-bar');
  if (ob) {
    ob.hidden = !S.offline;
    if (S.offline) {
      const n = Object.keys(S.pending || {}).length;
      ob.textContent = n
        ? '离线 · ' + n + ' 项打卡待同步，联网后自动上传'
        : '离线模式 · 正在显示本机缓存数据，联网后自动同步';
    }
  }
}


/* ==================== 本轮优化：个人基线 / 洞察 / 运动类型 / 快速操作 ==================== */
const SPORT_KIND = [
  [/run|jog|跑/i, 'run'], [/cycl|bike|骑行|单车/i, 'bike'], [/swim|游泳/i, 'swim'],
  [/hik|徒步|登山/i, 'hike'], [/walk|步行|快走/i, 'walk'],
  [/strength|weight|力量|gym/i, 'strength'], [/yoga|瑜伽/i, 'yoga'], [/row|划船/i, 'row']
];
function sportKind(a) {
  const raw = String(a.name || a.type || '');
  for (const it of SPORT_KIND) if (it[0].test(raw)) return it[1];
  return 'run';
}
/* 运动图标：Material Symbols Rounded（Apache-2.0）单路径线性图标，
   比原来多段描边的一套更简洁，缩到 13px 也不糊。viewBox 是 0 -960 960 960。 */
const SPORT_PATHS = {
run: 'M520-80v-200l-84-80-31 138q-4 16-17.5 24.5T358-192l-198-40q-17-3-26-17t-6-31q3-17 17-26.5t31-5.5l152 32 64-324-72 28v96q0 17-11.5 28.5T280-440q-17 0-28.5-11.5T240-480v-122q0-12 6.5-21.5T264-638l134-58q35-15 51.5-19.5T480-720q21 0 39 11t29 29l40 64q21 34 54.5 59t77.5 33q17 3 28.5 15t11.5 29q0 17-11.5 28t-27.5 9q-54-8-101-33.5T540-540l-24 120 72 68q6 6 9 13.5t3 15.5v243q0 17-11.5 28.5T560-40q-17 0-28.5-11.5T520-80Zm-36.5-683.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z',
  bike: 'M200-80q-83 0-141.5-58.5T0-280q0-83 58.5-141.5T200-480q83 0 141.5 58.5T400-280q0 83-58.5 141.5T200-80Zm85-115q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35Zm243-441-96 96 66 69q11 11 16.5 25t5.5 30v176q0 17-11.5 28.5T480-200q-17 0-28.5-11.5T440-240v-160L312-512q-12-11-18-25.5t-6-30.5q0-16 6.5-30.5T312-624l112-112q12-12 27.5-18t32.5-6q17 0 32.5 6t27.5 18l76 76q23 23 50.5 37.5T729-603q17 3 26.5 16t6.5 30q-3 17-16 26.5t-30 6.5q-45-8-84.5-28T560-604l-32-32Zm35.5-127.5Q540-787 540-820t23.5-56.5Q587-900 620-900t56.5 23.5Q700-853 700-820t-23.5 56.5Q653-740 620-740t-56.5-23.5ZM760-80q-83 0-141.5-58.5T560-280q0-83 58.5-141.5T760-480q83 0 141.5 58.5T960-280q0 83-58.5 141.5T760-80Zm85-115q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35Z',
  swim: 'M480-160q-36 0-57 20t-77 20q-56 0-77-20t-57-20q-29 0-44 13.5T121-125q-16 4-28.5-7T80-160q0-17 12-29.5t27-20.5q17-9 36-19.5t57-10.5q56 0 77 20t57 20q36 0 57-20t77-20q56 0 77 20t57 20q36 0 57-20t77-20q38 0 57 10.5t36 19.5q15 8 27 20.5t12 29.5q0 17-12.5 28t-28.5 7q-32-8-47-21.5T748-160q-36 0-57 20t-77 20q-56 0-77-20t-57-20Zm0-180q-38 0-56.5 20T346-300q-59 0-78.5-20T212-340q-29 0-44 13.5T121-305q-16 4-28.5-7T80-340q0-17 12-29.5t27-20.5q17-9 36-19.5t57-10.5q56 0 77.5 20t56.5 20q36 0 57-20t77-20q56 0 77 20t57 20q36 0 57-20t77-20q38 0 57 10.5t36 19.5q15 8 27 20.5t12 29.5q0 17-12.5 28t-28.5 7q-32-8-47-21.5T748-340q-36 0-55.5 20T614-300q-57 0-77.5-20T480-340ZM276-504l133-133-40-40q-25-25-51.5-39.5T257-736q-20-4-34.5-19T208-790q0-21 15-35.5t35-12.5q54 5 93 22.5t77 55.5l256 256q-17 11-33 17.5t-37 6.5q-36 0-57-20t-77-20q-56 0-77 20t-57 20q-21 0-37-6.5T276-504Zm463-306.5q29 29.5 29 70.5 0 42-29 71t-71 29q-42 0-71-29t-29-71q0-41 29-70.5t71-29.5q42 0 71 29.5Z',
  hike: 'M436-360 371-72q-3 14-14.5 23T330-40q-20 0-32-15t-8-34l113-573q6-29 27-43.5t44-14.5q23 0 42.5 10t31.5 30l40 64q18 29 46.5 52.5T700-529v-41q0-13 8.5-21.5T730-600q13 0 21.5 8.5T760-570v500q0 13-8.5 21.5T730-40q-13 0-21.5-8.5T700-70v-376q-48-11-89-35t-71-59l-24 120 72 68q6 6 9 13.5t3 15.5v243q0 17-11.5 28.5T560-40q-17 0-28.5-11.5T520-80v-200l-84-80Zm-178-82-46-9q-16-3-25-16.5t-6-30.5l30-157q6-34 36-51.5t65-10.5q17 3 25.5 16.5T343-670l-38 196q-3 17-16.5 26t-30.5 6Zm225.5-321.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z',
  walk: 'M436-364 371-72q-3 14-14.5 23T330-40q-20 0-32-15t-8-34l102-515-72 28v96q0 17-11.5 28.5T280-440q-17 0-28.5-11.5T240-480v-122q0-12 6.5-21.5T264-638l178-76q14-6 29.5-7t29.5 4q14 5 26.5 14t20.5 23l40 64q13 20 30.5 38t39.5 31q14 8 31 14.5t34 9.5q16 3 26.5 14.5T760-480q0 17-12 28t-29 9q-56-8-100.5-35T541-543l-25 123 72 68q6 6 9 13.5t3 15.5v243q0 17-11.5 28.5T560-40q-17 0-28.5-11.5T520-80v-220l-84-64Zm47.5-399.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z',
  strength: 'M282-622 168-508q-11 11-27.5 11.5T112-508q-11-11-11.5-27.5T111-564l29-30-28-28q-12-12-12-28t12-28l56-56-29-30q-11-11-11-27.5t12-28.5q11-11 27.5-11.5T196-821l30 29 56-56q12-12 28-12t28 12l28 28 30-29q11-11 27.5-11t28.5 12q11 11 11 28t-11 28L338-678l340 340 114-114q11-11 27.5-11.5T848-452q11 11 11.5 27.5T849-396l-29 30 28 28q12 12 12 28t-12 28l-56 56 29 30q11 11 11 27.5T820-140q-11 11-27.5 11.5T764-139l-30-29-56 56q-12 12-28 12t-28-12l-28-28-30 29q-11 11-27.5 11T508-112q-11-11-11-28t11-28l114-114-340-340Z',
  yoga: 'M272-160q-30 0-51-21t-21-51q0-21 12-39.5t32-26.5l156-62v-90q-48 55-108 87.5T162-322q-17 2-29.5-9.5T120-360q0-17 11-29t28-14q55-8 101-34t84-71l54-64q12-14 28-21t34-7h40q18 0 34 7t28 21l54 64q38 45 84 71t101 34q17 2 28 14t11 29q0 17-12.5 28.5T798-322q-70-8-130-40.5T560-450v90l156 62q20 8 32 26.5t12 39.5q0 30-21 51t-51 21H400v-20q0-26 17-43t43-17h120q9 0 14.5-5.5T600-260q0-9-5.5-14.5T580-280H460q-42 0-71 29t-29 71v20h-88Zm151.5-503.5Q400-687 400-720t23.5-56.5Q447-800 480-800t56.5 23.5Q560-753 560-720t-23.5 56.5Q513-640 480-640t-56.5-23.5Z',
  row: 'm692-28-80-80q-6-6-9-13.5t-3-15.5v-43L316-464q-9 2-18 3t-18 1v-88q50 2 102-21.5t84-58.5l56-62q13-15 30.5-22.5T590-720q38 0 64 26t26 64v230q0 26-9.5 47.5T644-314L500-456v-92q-20 17-43 31t-49 25l252 252h43q8 0 15.5 3t13.5 9l80 80q12 12 12 28t-12 28l-64 64q-12 12-28 12t-28-12ZM360-280 250-170q-13 13-30 13t-30-13q-13-13-13-30t13-30l150-150 100 100h-80Zm183.5-503.5Q520-807 520-840t23.5-56.5Q567-920 600-920t56.5 23.5Q680-873 680-840t-23.5 56.5Q633-760 600-760t-56.5-23.5ZM249-473q-13-13-13-31t13-31q13-13 31-13t31 13q13 13 13 31t-13 31q-13 13-31 13t-31-13Z',
};
function sportIcon(a, size) {
  const s = size || 14;
  const d = SPORT_PATHS[sportKind(a)] || SPORT_PATHS.run;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 -960 960 960" ' +
    'class="sic" aria-hidden="true" focusable="false"><path d="' + d + '" fill="currentColor"/></svg>';
}
function dataSince() { return dayKey(addDays(new Date(), -400)); }

const BASE_FIELDS = [
  { f: 'sleep_total', label: '睡眠', unit: 'h', d: 1, good: 'high', low: '今天留意恢复。', high: '状态不错。' },
  { f: 'hrv', label: 'HRV', unit: 'ms', d: 0, good: 'high', low: '适合把强度放低一点。', high: '恢复得不错。' },
  { f: 'resting_hr', label: '静息心率', unit: 'bpm', d: 0, good: 'low', low: '恢复得不错。', high: '注意别安排高强度。' },
  { f: 'training_load', label: '训练负荷', unit: '', d: 0, good: 'low', low: '还有余量。', high: '今天适合轻松一点。' }
];
function seriesBack(n, getter) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(getter(dayKey(addDays(new Date(), -i))));
  return out;
}
/* endDay 省略时以今天为准；传入具体日期用于「今天没数据、回落到最近一天」时
   仍按那一天的前 7 天算基线，避免拿昨天的值去比今天的基线。 */
function baselineOf(field, win, endDay) {
  const base = endDay ? parseDay(endDay) : new Date();
  const vals = [];
  for (let i = 1; i <= win; i++) {
    const h = S.health[dayKey(addDays(base, -i))];
    const v = h ? num(h[field]) : null;
    if (v !== null && isFinite(v)) vals.push(v);
  }
  if (vals.length < 3) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length };
}
function fieldDeltaAt(field, day) {
  const h = S.health[day];
  const v = h ? num(h[field]) : null;
  if (v === null) return null;
  const b = baselineOf(field, 7, day);
  if (!b) return null;
  return { cur: v, base: b.avg, delta: v - b.avg, rel: b.avg ? (v - b.avg) / b.avg : 0, n: b.n };
}
function fieldDelta(field) { return fieldDeltaAt(field, TODAY()); }
/* 最近一个有身体数据的日期（只在往回 catch 天以内找，避免拿到半年前的值冒充） */
function latestHealthDay(catchDays) {
  const span = catchDays || 7;
  for (let i = 0; i < span; i++) {
    const k = dayKey(addDays(new Date(), -i));
    const h = S.health[k];
    if (h && [h.sleep_total, h.hrv, h.resting_hr].some(v => v !== null && v !== undefined)) return k;
  }
  return null;
}
function sparkSVG(vals, color) {
  const nn = vals.filter(v => v !== null && v !== undefined && isFinite(v));
  if (nn.length < 2) return '<span class="gfoot">近 14 天数据不足，暂时画不出走势</span>';
  const W = 240, H = 24, P = 2;
  const lo = Math.min.apply(null, nn), hi = Math.max.apply(null, nn), span = (hi - lo) || 1;
  let d = '', started = false;
  vals.forEach(function (v, i) {
    if (v === null || v === undefined || !isFinite(v)) { started = false; return; }
    const x = P + (i / (vals.length - 1)) * (W - 2 * P);
    const y = H - P - ((v - lo) / span) * (H - 2 * P);
    d += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    started = true;
  });
  return '<svg class="sparkline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近 14 天走势">' +
    '<path d="' + d.trim() + '" fill="none" stroke="' + (color || 'var(--blue)') + '" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function avgMetric(getter, startBack, count) {
  const vals = [];
  for (let i = startBack; i < startBack + count; i++) {
    const v = getter(dayKey(addDays(new Date(), -i)));
    if (v !== null && v !== undefined && isFinite(v)) vals.push(v);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function cmpHTML(cur, prev, n) {
  if (cur === null || prev === null || !prev) return '<div class="cmp">暂无对比数据</div>';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(pct) < 0.5) return '<div class="cmp">与前一个 ' + n + ' 天持平</div>';
  return '<div class="cmp ' + (pct > 0 ? 'up' : 'down') + '">' + (pct > 0 ? '↑ ' : '↓ ') +
    Math.abs(Math.round(pct)) + '% · 较前 ' + n + ' 天</div>';
}
function weekReview() {
  const ws = weekStart(new Date());
  const thisDays = [], prevDays = [];
  for (let i = 0; i < 7; i++) {
    const k = dayKey(addDays(ws, i));
    if (k <= TODAY()) thisDays.push(k);
  }
  thisDays.forEach(k => prevDays.push(dayKey(addDays(parseDay(k), -7))));
  const avgRate = ds => {
    const v = ds.map(rateOfDay).filter(x => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const avgSleep = ds => {
    const v = ds.map(d => { const h = S.health[d]; return h && h.sleep_total != null ? Number(h.sleep_total) : null; })
      .filter(x => x !== null && isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const actN = ds => ds.reduce((n, d) => n + activitiesForDay(d).length, 0);
  const logN = ds => S.logs.filter(l => ds.indexOf(String(l.day).slice(0, 10)) >= 0).length;
  return [
    { k: '打卡完成率', cur: avgRate(thisDays), prev: avgRate(prevDays), fmt: v => v === null ? '—' : Math.round(v * 100) + '%' },
    { k: '平均睡眠', cur: avgSleep(thisDays), prev: avgSleep(prevDays), fmt: v => v === null ? '—' : fmt1(v) + 'h' },
    { k: '运动次数', cur: actN(thisDays), prev: actN(prevDays), fmt: v => v + ' 次' },
    { k: '学习记录', cur: logN(thisDays), prev: logN(prevDays), fmt: v => v + ' 次' }
  ];
}
function reviewHTML() {
  const monday = new Date().getDay() === 1;
  let html = '<details class="review" id="week-review"' + (monday ? ' open' : '') + '>' +
    '<summary>本周回顾 · 对比上周 <span class="rs">' + (monday ? '每周一自动展开' : '点此展开') + '</span></summary>' +
    '<div class="review-body">';
  weekReview().forEach(r => {
    let delta = '—', cls = '';
    if (r.cur !== null && r.prev !== null && r.prev !== 0) {
      const pct = (r.cur - r.prev) / Math.abs(r.prev) * 100;
      cls = pct > 0.5 ? 'up' : (pct < -0.5 ? 'down' : '');
      delta = (pct > 0 ? '↑ ' : pct < 0 ? '↓ ' : '') + Math.abs(Math.round(pct)) + '%';
    }
    html += '<div class="rv-row"><span class="rk">' + r.k + '</span>' +
      '<span class="rv">' + r.fmt(r.cur) + '</span>' +
      '<span class="rp">上周 ' + r.fmt(r.prev) + '</span>' +
      '<span class="rd ' + cls + '">' + delta + '</span></div>';
  });
  return html + '</div></details>';
}
const CORR_FIELDS = [
  ['sleep_total', '睡眠时长'], ['hrv', 'HRV'], ['resting_hr', '静息心率'],
  ['training_load', '训练负荷'], ['steps', '步数'], ['stress', '压力']
];
function factorInsights(days) {
  return CORR_FIELDS.map(function (x) {
    const pr = corrPairs(days, x[0]);
    const r = pr.n >= 3 ? pearson(pr.xs, pr.ys) : null;
    return { field: x[0], label: x[1], n: pr.n, r: r, p: r === null ? null : pValue(r, pr.n) };
  }).sort((a, b) => Math.abs(b.r || 0) - Math.abs(a.r || 0));
}
function dataHealth() {
  const last7 = seriesBack(7, d => d);
  const cs = window.Coros ? Coros.status() : { connected: false };
  return {
    have: last7.filter(d => !!S.health[d]).length,
    acts: last7.reduce((n, d) => n + activitiesForDay(d).length, 0),
    connected: !!cs.connected, lastSync: cs.lastSync || null,
    deleted: recentDeleted().length, snapshotAt: S.snapshotAt
  };
}
/* 快照新鲜度 / 数据不完整提示。
   只要有一张表没读到、或处于离线模式，界面显示的就是本机缓存 —— 必须一直说出来。
   以前只在「我的」里一行小字加 6 秒 toast，用户看到的现象是「新增/删除后刷新又变回原样」，
   却找不到原因。 */
function snapAgeText() {
  if (!S.snapshotAt) return '';
  const mins = Math.floor((Date.now() - new Date(S.snapshotAt).getTime()) / 60000);
  if (!isFinite(mins) || mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  if (mins < 1440) return Math.floor(mins / 60) + ' 小时前';
  return Math.floor(mins / 1440) + ' 天前';
}
function renderFreshness() {
  const el = $('#fresh-bar'); if (!el) return;
  const age = snapAgeText();
  const broken = (S.loadFailed || []).map(t => LOAD_LABELS[t] || t);
  let msg = '';
  if (broken.length >= LOAD_TABLES.length) {
    /* 八张表全没读到 = 整体连不上云端，逐表列名字只会变成一屏噪音 */
    msg = '暂时读不到云端 · 显示本机缓存' + (age ? '（更新于 ' + age + '）' : '') + ' · 点此重试';
  } else if (broken.length) {
    msg = broken.join('、') + ' 未更新 · 当前显示本机缓存' +
      (age ? '（更新于 ' + age + '）' : '') + ' · 点此重试';
  } else if (S.offline) {
    msg = '离线模式 · 显示本机缓存' + (age ? '（更新于 ' + age + '）' : '');
  } else if (S.snapshotAt) {
    const mins = Math.floor((Date.now() - new Date(S.snapshotAt).getTime()) / 60000);
    if (isFinite(mins) && mins >= 60) msg = '数据更新于 ' + age + ' · 重新打开可刷新';
  }
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.style.color = broken.length ? 'var(--orange)' : '';
  /* 有表没读到时整条可点＝立刻重拉一次（下拉刷新在 PWA 里不一定好使，
     给一个明面上的重试入口） */
  if (broken.length) {
    el.setAttribute('data-act', 'reloadall');
    el.style.cursor = 'pointer';
  } else {
    el.removeAttribute('data-act');
    el.style.cursor = '';
  }
}
/* 顶部「重新加载」：重新从云端拉一遍，并明确回报结果（而不是转一圈什么也不说） */
async function reloadAll() {
  toast('正在从云端重新读取…');
  try {
    await loadAll();
    saveSnapshot();
    render();
    toast(S.loadWarnings ? '仍没读到：' + (S.loadFailed || []).map(t => LOAD_LABELS[t] || t).join('、') : '已与云端同步');
  } catch (e) {
    render();
    toast('重新加载失败：' + ((e && e.message) || '网络异常'), null, 6000);
  }
}
/* 打卡只更新被点的行与今日环形，不再整页重绘；失败回滚走 toggleCheckin 内的全量 render */
function patchCheckinUI(habitId, day, actName) {
  /* 打卡项有两种形态：首页的胶囊（.hchip）与列表行（.lrow），两者都靠 data-act/data-id 定位 */
  const row = document.querySelector('[data-act="' + actName + '"][data-id="' + habitId + '"]');
  if (row) {
    const on = isDone(habitId, day);
    row.classList.toggle('done', on);
    const chk = row.querySelector('.chk');
    if (chk) {
      chk.classList.toggle('on', on);
      chk.innerHTML = on ? icon('check', row.classList.contains('hchip') ? 12 : 15) : '';
    }
    /* 横排项的外框是勾选框：未完成＝习惯色半透明描边 + 透明底，完成＝实色 + 白勾 */
    const hbox = row.querySelector('.hbox');
    if (hbox) {
      const hb = S.habits.find(x => String(x.id) === String(habitId));
      const col = (hb && hb.color) || '#0A84FF';
      hbox.style.borderColor = on ? col : hbTint(on, col).border;
      hbox.style.background = on ? col : hbTint(on, col).bg;
      hbox.style.color = on ? '#fff' : 'transparent';
    }
    if (row.hasAttribute('aria-checked')) {
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      const nm = row.querySelector('.lrow-t, .hchip-t');
      if (nm) row.setAttribute('aria-label', nm.textContent + '，' + (on ? '已完成' : '未完成'));
    }
    const pend = pendingOf(habitId, day) !== undefined;
    row.classList.toggle('pending', pend);
    const sub = row.querySelector('.lrow-sub');
    if (sub) {
      const base = sub.textContent.replace(/ · 待同步$/, '');
      sub.textContent = base + (pend ? ' · 待同步' : '');
    }
    row.classList.remove('pop'); void row.offsetWidth; row.classList.add('pop');
  }
  /* 完成度已收进打卡标题：打卡后只改这个小字，不再重绘整块 */
  const prog = $('#habit-prog');
  if (prog && day === TODAY()) prog.textContent = doneCount(day) + '/' + dayEntries(day);
  const cp = $('#cal-progress');
  if (cp) cp.textContent = '完成 ' + doneCount(day) + '/' + dayEntries(day);
}
function undoDelete(kind, id, label) {
  return async function () {
    await restoreRow(kind, id);          // restoreRow 内部会 render
    if (kind === 'note' && S._openBook) openBook(S._openBook);
    toast(label + '已恢复');
  };
}
function swipeMonth(dir) {
  S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + dir, 1);
  render();
}
function openCalJumpSheet() {
  const nowY = new Date().getFullYear(), cy = S.calMonth.getFullYear(), cm = S.calMonth.getMonth() + 1;
  let ys = '', ms = '';
  for (let y = nowY - 5; y <= nowY + 1; y++) ys += '<option value="' + y + '"' + (y === cy ? ' selected' : '') + '>' + y + ' 年</option>';
  for (let m = 1; m <= 12; m++) ms += '<option value="' + m + '"' + (m === cm ? ' selected' : '') + '>' + m + ' 月</option>';
  openSheet('<div class="grabber"></div><div class="sheet-h"><div class="t">跳转到年月</div>' +
    '<button data-act="closesheet">取消</button></div><div class="sheet-body">' +
    '<div class="card" style="padding:14px;display:flex;gap:10px">' +
    '<select id="cj-year" aria-label="年">' + ys + '</select>' +
    '<select id="cj-month" aria-label="月">' + ms + '</select></div>' +
    '<div style="margin-top:18px"><button class="btnblock blue" data-act="calgo">跳转</button></div></div>');
}
const QUICK_ACTS = [
  { t: '新建打卡项', s: '添加一个每日习惯', i: 'plus', do: 'newhabit', q: '新建打卡项 习惯 habit' },
  { t: '添加 / 同步书籍', s: '微信读书同步或手动添加', i: 'book', do: 'addbook', q: '添加 同步 书架 微信读书 weread api' },
  { t: '新建学习计划', s: '设定每周目标次数', i: 'pen', do: 'newplan', q: '新建学习计划 目标' },
  { t: '记一次学习', s: '给第一个计划记一次', i: 'check', do: 'logfirst', q: '记一次 学习 记录' },
  { t: '同步身体数据', s: '从 COROS 拉取近 7 天', i: 'refresh', do: 'corosSync', q: '同步 coros 身体数据 睡眠' },
  { t: '回到今天', s: '日历跳回本月今天', i: 'calendar', do: 'caltoday', q: '回到今天 日历 本月' },
  { t: '打开趋势', s: '查看近 30 天变化', i: 'chart', do: 'tab:trend', q: '趋势 图表 变化' },
  { t: '切换外观', s: '深色 / 浅色', i: 'moon', do: 'theme', q: '切换外观 深色 浅色 主题' }
];
function openQuickSheet() {
  let html = '<div class="grabber"></div><div class="sheet-h"><div class="t">快速操作</div>' +
    '<button data-act="closesheet">关闭</button></div><div class="sheet-body">' +
    '<input class="quick-q" id="quick-q" type="text" placeholder="搜索动作…（⌘K / Ctrl+K）" aria-label="搜索动作">' +
    '<div class="quick-hint">常用动作 · 输入关键词可过滤</div><div class="card" id="quick-list">';
  QUICK_ACTS.forEach(a => {
    html += '<button class="rowbtn" data-act="quickgo" data-do="' + a.do + '" data-q="' + esc(a.q) + '">' +
      '<div class="icbox" style="background:var(--blue-soft);color:var(--blue)">' + icon(a.i, 17) + '</div>' +
      '<div style="flex:1;min-width:0"><div class="rb-t">' + esc(a.t) + '</div>' +
      '<div class="rb-s">' + esc(a.s) + '</div></div><div class="chev">' + icon('chev', 15) + '</div></button>';
  });
  html += '</div></div>';
  openSheet(html);
}
async function runCorosSync() {
  if (!window.Coros) return;
  const st = Coros.status();
  if (!st.connected) { toast('请先连接 COROS'); return; }
  const btns = $$('[data-act="corosSync"]');
  btns.forEach(b => { b.classList.add('busy'); b.setAttribute('disabled', ''); });
  toast('正在同步…');
  try {
    const res = await Coros.sync();
    corosRetryAt = 0;
    if (Number((res && res.days) || 0) > 0 || Number((res && res.activities) || 0) > 0) {
      markCorosAutoDone();          // 手动同步拿到数据，今天就不必再自动跑一次
    }
    try { await loadAll(); render(); }
    catch (e) { toast('同步完成，但刷新数据失败：' + ((e && e.message) || '')); return; }
    const w = (res && res.warnings) || [];
    toast('已同步 ' + ((res && res.days) || 0) + ' 天身体数据、' +
      ((res && res.activities) || 0) + ' 条运动' +
      (w.length ? '，' + w.length + ' 处未识别，请查看同步诊断' : ''));
  } catch (e) {
    toast(e && e.soft ? e.message : 'COROS 同步失败：' + ((e && e.message) || '未知错误，请查看同步诊断'));
  } finally {
    btns.forEach(b => { b.classList.remove('busy'); b.removeAttribute('disabled'); });
  }
}

/* ---- 每天首次打开自动同步 COROS ----------------------------------------
   每天第一次进入应用时静默拉一次当天数据，成功后重载并重绘，用户不用手动点。
   只在成功时写「今天已同步」标记：失败就留到下次打开重试，不会把当天锁死。 */
const COROS_AUTO_KEY = 'lb.corosAutoDay';
let corosAutoBusy = false;
let corosRetryAt = 0;          // 0 天/失败后的退避时间，避免每 5 分钟重跑一轮 MCP
function corosAutoDoneToday() {
  try { return localStorage.getItem(COROS_AUTO_KEY) === TODAY(); } catch (e) { return false; }
}
function markCorosAutoDone() {
  try { localStorage.setItem(COROS_AUTO_KEY, TODAY()); } catch (e) {}
}
async function syncCorosDaily(opts) {
  const o = opts || {};
  if (!window.Coros || !S.user || S.offline || navigator.onLine === false) return { skipped: true };
  if (corosAutoBusy) return { skipped: true };
  if (!o.force && corosAutoDoneToday()) return { skipped: true };
  if (!o.force && Date.now() < corosRetryAt) return { skipped: true };
  let st;
  try {
    /* 冷启动的关键时序：Coros.afterLogin() 读令牌是异步的（一次 app_kv 请求），
       本函数若抢在它之前调 status()，会读到空 cache 判定「未连接」并静默跳过。
       以前 enterApp 里 afterLogin 没有 await，正是「每天自动同步、今日却始终空着」
       的根因：跳过时既不标记也不写诊断，所以连失败记录都查不到。 */
    if (Coros.afterLogin) await Coros.afterLogin();
    st = Coros.status();
  } catch (e) { console.warn('[coros] 自动同步准备失败', e); return { skipped: true, why: 'auth' }; }
  if (!st || !st.connected) {
    console.warn('[coros] 自动同步跳过：COROS 未连接或令牌缺失');
    return { skipped: true, why: 'not-connected' };
  }
  corosAutoBusy = true;
  try {
    const res = await Coros.sync();
    const wroteDays = Number((res && res.days) || 0);
    const wroteActs = Number((res && res.activities) || 0);
    /* 只有真的拿到数据才算「今天已完成」：0 天时若也标记，当天就再也不会重试，
       一旦 COROS 侧报告晚生成，今日格就空一整天。0 天改为 30 分钟后退避重试。 */
    if (wroteDays > 0 || wroteActs > 0) markCorosAutoDone();
    else corosRetryAt = Date.now() + 30 * 60 * 1000;
    /* 同步写入云端后必须重新拉一次，否则页面还停在同步前的内存快照 */
    try { await loadAll(); saveSnapshot(); render(); } catch (e) {}
    const w = (res && res.warnings) || [];
    if (!o.silent) {
      toast('已自动同步 ' + ((res && res.days) || 0) + ' 天身体数据、' +
        ((res && res.activities) || 0) + ' 条运动' +
        (w.length ? '，' + w.length + ' 处未识别' : ''));
    }
    return { ok: true, res: res };
  } catch (e) {
    noteWriteError('corosAutoSync', e);
    /* 失败也退避 30 分钟：看门狗每 5 分钟一次，避免令牌失效时反复打 MCP 接口 */
    corosRetryAt = Date.now() + 30 * 60 * 1000;
    if (!o.silent) toast('COROS 同步失败，30 分钟后会再试');
    return { ok: false, error: e };
  } finally {
    corosAutoBusy = false;
  }
}

/* ==================== 今日 ==================== */

/* 一行身体数据是否「够格」当今天的值：只认这三格里至少一个真值。
   COROS 每天都会写 step / stress / training_load，若把这种只有步数的行当成
   「今天已有数据」，三格就全变「—」、回落提示也不再出现——用户看到的就是
   「同步完了还是没更新」。所以必须按核心字段判断，而不是「行存在」。 */
function hasCoreHealth(h) {
  return !!h && ['sleep_total', 'hrv', 'resting_hr'].some(f => {
    const v = h[f];
    return v !== null && v !== undefined && v !== '';
  });
}
function corosStatus() {
  try { return (window.Coros && Coros.status && Coros.status()) || null; } catch (e) { return null; }
}
function healthCells(day) {
  const own = S.health[day];
  /* 今天还没有核心数据时回落到最近一天（7 天内）：状态栏不能一直空着。
     但必须在下方的提示行里标注数据日期，不能拿昨天的数值冒充今天。 */
  const srcDay = hasCoreHealth(own) ? day : latestHealthDay(7);
  const h = (srcDay && S.health[srcDay]) || {};
  /* 只留三格：训练负荷对日常决策帮助最小（且 COROS 常给空值），
     移除后网格改为 3 列；它在趋势页的相关性与详情弹层里仍可查看。 */
  const cells = [
    { k: '睡眠', f: 'sleep_total', v: fmt1(num(h.sleep_total)), u: 'h' },
    { k: 'HRV', f: 'hrv', v: h.hrv == null ? '—' : Math.round(h.hrv), u: 'ms' },
    { k: '静息心率', f: 'resting_hr', v: h.resting_hr == null ? '—' : Math.round(h.resting_hr), u: 'bpm' }
  ];
  return '<div class="health"' + (srcDay && srcDay !== day ? ' data-day="' + srcDay + '"' : '') + '>' + cells.map(c => {
    const d = srcDay ? fieldDeltaAt(c.f, srcDay) : null;
    let dh = '';
    if (d && c.v !== '—') {
      const f = BASE_FIELDS.find(x => x.f === c.f) || BASE_FIELDS[0];
      const up = d.delta > 0, good = (f.good === 'high') === up;
      const abs = f.d ? (Math.round(Math.abs(d.delta) * 10) / 10).toFixed(1) : String(Math.round(Math.abs(d.delta)));
      dh = '<div class="hdelta ' + (Math.abs(d.rel) < 0.08 ? '' : (good ? 'good' : 'warn')) + '">' +
        (Math.abs(d.rel) < 0.08 ? '≈ 常态' : (up ? '↑ ' : '↓ ') + abs) + '</div>';
    } else if (d) dh = '<div class="hdelta">基线数据不足</div>';
    return '<div class="hcell' + (c.v === '—' ? ' nil' : '') + '" data-act="healthdetail" data-id="' + c.f + '" ' +
      'role="button" tabindex="0" aria-label="' + c.k + ' ' + c.v + c.u + '">' +
      '<div class="k">' + c.k + '</div>' +
      '<div class="v">' + c.v + (c.u && c.v !== '—' ? '<span class="u">' + c.u + '</span>' : '') + '</div>' + dh + '</div>';
  }).join('') + '</div>' + (S.sparkField ? sparkCardHTML(S.sparkField) : '');
}

/* 今日状态下面的说明行。三格回落时最容易被误解成「同步没生效」，所以这里要说清
   三件事：同步到底跑没跑（几点）、COROS 今天有什么、上面显示的是哪一天。 */
function healthHintHTML(day, own) {
  if (hasCoreHealth(own)) return '';
  const srcDay = latestHealthDay(7);
  const md = srcDay ? (Number(srcDay.slice(5, 7)) + '月' + Number(srcDay.slice(8, 10)) + '日') : '';
  const st = corosStatus() || {};
  let syncedToday = false, hhmm = '';
  if (st.lastSyncAt) {
    const t = new Date(st.lastSyncAt);
    if (!isNaN(t.getTime()) && dayKey(t) === day) {
      syncedToday = true;
      hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    }
  }
  /* 只有步数/压力也说明同步成功过——这比一句「还没同步」有用得多 */
  const bits = [];
  if (own && own.steps != null) bits.push('步数 ' + Math.round(own.steps));
  if (own && own.stress != null) bits.push('压力 ' + Math.round(own.stress));
  let main;
  if (bits.length) main = '今天只有' + bits.join('、') + (syncedToday ? ' · 已同步 ' + hhmm : '');
  else if (syncedToday) main = '已同步 ' + hhmm + '，但 COROS 今天没有睡眠/HRV 记录';
  else main = '今天还没同步';
  const sub = srcDay ? '上面是 ' + md + ' 的数据' : '暂时还没有身体数据';
  return '<div class="gfoot sync-note">' +
    '<span class="sn-main">' + main + '</span>' +
    '<span class="sn-sub">' + sub + '</span>' +
    '<button class="pill" data-act="corosSync" aria-label="' + (syncedToday ? '重新同步' : '立即同步') + ' COROS 身体数据">' +
    (syncedToday ? '重新同步' : '立即同步') + '</button></div>';
}
function sparkCardHTML(field) {
  const f = BASE_FIELDS.find(x => x.f === field) || BASE_FIELDS[0];
  const vals = seriesBack(14, d => { const h = S.health[d]; return h ? num(h[field]) : null; });
  const d = fieldDelta(field);
  const base = d ? (f.d ? (Math.round(d.base * 10) / 10).toFixed(1) : String(Math.round(d.base))) + f.unit : '基线数据不足';
  return '<div class="sparkcard" id="health-spark"><div class="sh"><span>' + f.label + ' · 近 14 天</span>' +
    '<span>个人基线 ' + base + '</span></div>' +
    sparkSVG(vals, field === 'hrv' ? 'var(--green)' : 'var(--blue)') + '</div>';
}

/* 把 #RRGGBB 转成带透明度的 rgba：横排打卡的未完成态用「淡色底 + 彩色图标」，
   比实色圆更轻，也不会让一排圆点抢走完成度环的注意力。非 hex 原样返回。 */
function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
  if (!m) return hex || 'var(--fill-3)';
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

/* 今日打卡的每一项是一条胶囊：勾选框 + 名称，横向铺开、超宽就滑。
   为什么不是「大方块 + 名称在下」：那几个 30px 空框漂在 110px 宽的格子里，
   剩下的都是空气，一排看过去像四个未填的表格；胶囊把勾和名字绑在一起，
   宽度跟着名字走，视觉重量与"一条可点的动作"相符。
   勾选框（.hbox）与纵向行、日历日详情共用同一套。 */
/* 勾选框的描边与淡底强度看主题：浅色背景上 45%/12% 太淡，整排框会「消失」；
   深色背景上相反，淡到刚好能看见轮廓才不抢眼。 */
function hbTint(on, col) {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    border: on ? col : tint(col, light ? 0.62 : 0.45),
    bg: on ? col : tint(col, light ? 0.15 : 0.12)
  };
}
function habitChip(h, day, actName) {
  const on = isDone(h.id, day);
  const pend = pendingOf(h.id, day) !== undefined;
  const col = h.color || '#0A84FF';
  const a11y = ' role="checkbox" tabindex="0" aria-checked="' + (on ? 'true' : 'false') +
    '" aria-label="' + esc(h.name + '，' + (on ? '已完成' : '未完成')) + '"';
  return '<div class="hchip' + (on ? ' done' : '') + (pend ? ' pending' : '') +
    '" data-act="' + actName + '" data-id="' + h.id + '" data-day="' + day + '"' + a11y + '>' +
    '<div class="hbox" style="border-color:' + esc(hbTint(on, col).border) +
    ';background:' + esc(hbTint(on, col).bg) + ';color:' + esc(on ? '#fff' : 'transparent') + '">' +
    '<span class="chk' + (on ? ' on' : '') + '">' + (on ? icon('check', 12) : '') + '</span></div>' +
    '<span class="hchip-t">' + esc(h.name) + '</span>' +
    (pend ? '<span class="hchip-pend">待同步</span>' : '') + '</div>';
}

/* 纵向行（日历、首页编辑态）与横排格共用同一个勾选框：勾选框固定在最左，
   编辑态在右侧换成删除按钮。以前这里画的是 30px 彩色图标 + 右侧圆圈勾，
   跟首页的方形勾选框是两套外观，同一个动作要认两遍。 */
function habitRow(h, day, editing, actName) {
  const on = isDone(h.id, day);
  /* 打卡是核心动作，必须能被键盘与读屏操作；编辑态下父行不可打卡，不再放进 Tab 序列 */
  const a11y = editing ? '' :
    ' role="checkbox" tabindex="0" aria-checked="' + (on ? 'true' : 'false') +
    '" aria-label="' + esc(h.name + '，' + (on ? '已完成' : '未完成')) + '"';
  const pend = pendingOf(h.id, day) !== undefined;
  const col = h.color || '#0A84FF';
  return '<div class="lrow' + (on ? ' done' : '') + (pend ? ' pending' : '') + '" data-act="' + actName + '" data-id="' + h.id + '" data-day="' + day + '"' + a11y + '>' +
    '<div class="hbox" style="border-color:' + esc(on ? col : tint(col, 0.5)) +
    ';background:' + esc(on ? col : 'transparent') + ';color:' + esc(on ? '#fff' : 'transparent') + '">' +
    '<span class="chk' + (on ? ' on' : '') + '">' + (on ? icon('check', 15) : '') + '</span></div>' +
    '<div class="lbody"><div class="lrow-t">' + esc(h.name) + '</div>' +
    '<div class="lrow-sub">' + esc(h.target || '每天') + (pend ? ' · 待同步' : '') + '</div></div>' +
    (editing ? '<div class="minus" data-act="delhabit" data-id="' + h.id + '">' + icon('minus', 15) + '</div>' : '') +
    '</div>';
}

function renderToday() {
  const day = TODAY();
  const total = dayEntries(day);
  const done = doneCount(day);
  const d = parseDay(day);
  const reading = activeBooks().filter(b => b.status === 'reading').slice(0, 6);
  const h = S.health[day];

  let html = '<div class="head"><div class="date">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WK[d.getDay()] + '</div>' +
    '<h2>今日</h2></div>';

  /* 首屏不再放整块完成度卡片：圆环 + 两句话的「今天还没开始 / 已启动」
     占掉近 110px 却只表达一个比例，完成度收进打卡标题右侧的小字。 */

  /* 今日状态（身体数据）在最上：它每天只有一个值，先看一眼就知道今天什么状态 */
  html += '<div class="gtitle"><span>今日状态</span></div>';
  html += healthCells(day);
  html += healthHintHTML(day, h);

  /* 打卡是核心动作，紧跟今日状态。
     分组名做成行首小标签，与勾选项、编辑、新建共用一行——整块只有 30px，
     不再为「今日打卡 2/3 / 编辑」单独占一行。 */
  html += '<div class="habit-row">' +
    '<div class="habit-lead"><span class="hl-t">今日打卡</span><span class="hl-s">打卡</span>' +
    (total ? '<span class="gnum" id="habit-prog">' + done + '/' + total + '</span>' : '') + '</div>';
  if (total && !S.editing) {
    html += '<div class="habit-strip" id="habit-strip">' +
      habitsForDay(day).map(x => habitChip(x, day, 'toggle')).join('') + '</div>';
  } else {
    html += '<div style="flex:1"></div>';
  }
  if (total) {
    /* 编辑态必须一眼能退出，所以给文字「完成」；正常态只是次要入口，用铅笔图标 */
    html += S.editing
      ? '<button class="habit-done" data-act="edittoggle">完成</button>'
      : '<button class="habit-btn" data-act="edittoggle" title="编辑打卡项" aria-label="编辑打卡项">' +
        icon('pen', 15) + '</button>';
  }
  if (!S.editing) {
    html += '<button class="habit-btn" data-act="newhabit" title="新建打卡项" aria-label="新建打卡项">' +
      icon('plus', 15) + '</button>';
  }
  html += '</div>';

  if (!total) {
    html += '<div class="card" style="margin-top:10px"><div class="empty">还没有打卡项。<br>' +
      '点上方 + 新建一个，或到「我的 → 打卡项管理」添加。</div></div>';
  } else if (S.editing) {
    /* 编辑态保留纵向列表：删除按钮需要整行宽度，行内勾选项放不下 */
    html += '<div class="card" style="margin-top:10px">' +
      habitsForDay(day).map(x => habitRow(x, day, true, 'toggle')).join('') + '</div>';
  }

  html += reviewHTML();

  /* 在读：封面横滑。缩到 60px 宽（封面 80px）+ 单行书名 + 进度细条，
     整卡约 126px——比最早的 176 矮一截，但书封仍是主角。 */
  if (reading.length) {
    html += '<div class="sec-head"><div class="sec-t">在读</div>' +
      '<button style="color:var(--blue);font-size:14px" data-act="tab" data-id="library">全部</button></div>';
    html += '<div class="card"><div class="rail sm">' + reading.map(b => {
      const pr = Math.max(0, Math.min(100, Number(b.progress) || 0));
      return '<div class="bk" data-act="openbook" data-id="' + b.id + '">' + bookCover(b) +
        '<div class="bk-t">' + esc(b.title) + '</div>' +
        (pr > 0 ? '<div class="bk-prog"><i style="width:' + pr + '%"></i></div>' : '') + '</div>';
    }).join('') + '</div></div>';
  }

  if (S.activities.length) {
    const a = S.activities[0];
    /* 日期跟全站统一用「11月21日」，不要再出现 2026-11-21 这种机器格式 */
    const ad = parseDay(String(a.day).slice(0, 10));
    const dstr = (ad.getMonth() + 1) + '月' + ad.getDate() + '日';
    html += '<div class="gtitle">最近运动</div><div class="card">' +
      '<div class="lrow" style="cursor:default">' +
      '<div class="licon" style="background:var(--green)">' + sportIcon(a, 17) + '</div>' +
      '<div class="lbody"><div class="lrow-t">' + esc(sportName(a)) + '</div>' +
      '<div class="lrow-sub">' + dstr + (a.duration_sec ? ' · ' + Math.round(a.duration_sec / 60) + ' 分钟' : '') +
      (a.distance_m ? ' · ' + (a.distance_m / 1000).toFixed(2) + ' km' : '') + '</div></div></div></div>';
  }

  $('#view-today').innerHTML = html;
}

/* ==================== 封面 ==================== */
const COVER_PAIRS = [
  ['#1E3A8A', '#3B82F6'], ['#7C2D12', '#EA580C'], ['#134E4A', '#14B8A6'],
  ['#4C1D95', '#8B5CF6'], ['#831843', '#EC4899'], ['#1F2937', '#6B7280'],
  ['#78350F', '#D97706'], ['#0C4A6E', '#0284C7'], ['#3F1D38', '#A855F7'],
  ['#14532D', '#22C55E']
];
function coverOf(b) {
  if (b.cover_a && b.cover_b) return [b.cover_a, b.cover_b];
  let hsum = 0;
  const t = String(b.title || '');
  for (let i = 0; i < t.length; i++) hsum = (hsum * 31 + t.charCodeAt(i)) % 99991;
  return COVER_PAIRS[hsum % COVER_PAIRS.length];
}
/* size: undefined=书架/横滑默认尺寸，'lg'=书籍详情大封面，'xs'=在读列表里的小封面 */
function bookCover(b, size) {
  const c = coverOf(b);
  const cls = size === 'xs' ? ' xs' : (size === 'lg' || size === true) ? ' lg' : '';
  return '<div class="bk-cover' + cls + '" style="background-image:' +
    'linear-gradient(180deg,rgba(0,0,0,.46) 0%,rgba(0,0,0,.10) 42%,rgba(0,0,0,.34) 100%),' +
    'linear-gradient(140deg,' + c[0] + ',' + c[1] + ')">' +
    '<span>' + esc(b.title) + '</span></div>';
}

/* ==================== 日历 ==================== */
function levelOf(day) {
  const p = rateOfDay(day);              // 按当日有效习惯快照，不随增删习惯漂移
  if (p === null || p <= 0) return 0;
  if (p >= 1) return 4;
  if (p >= 0.7) return 3;
  if (p >= 0.4) return 2;
  return 1;
}

/* 运动记录：COROS 同步写入 activities，day 可能是 date 列返回的 ISO 串 */
function activitiesForDay(day) {
  return (S.activities || []).filter(a => String(a.day).slice(0, 10) === day);
}
const SPORT_NAMES = {
  'indoor run': '室内跑步', 'outdoor run': '户外跑步', 'run': '跑步', 'trail run': '越野跑',
  'indoor cycling': '室内骑行', 'cycling': '骑行', 'outdoor cycling': '户外骑行',
  'pool swim': '泳池游泳', 'swimming': '游泳', 'open water swim': '公开水域游泳',
  'hiking': '徒步', 'walking': '步行', 'strength': '力量训练', 'workout': '训练',
  'yoga': '瑜伽', 'rowing': '划船', 'indoor row': '室内划船'
};
function sportName(a) {
  const raw = String(a.name || a.type || '运动').trim();
  return SPORT_NAMES[raw.toLowerCase()] || raw;
}
function activityRow(a) {
  const bits = [];
  const dur = Number(a.duration_sec), dist = Number(a.distance_m);
  const hr = Number(a.avg_hr), kcal = Number(a.calories);
  if (isFinite(dur) && dur > 0) bits.push(Math.round(dur / 60) + ' 分钟');
  if (isFinite(dist) && dist > 0) bits.push((dist / 1000).toFixed(2) + ' km');
  if (isFinite(hr) && hr > 0) bits.push('均心率 ' + Math.round(hr));
  if (isFinite(kcal) && kcal > 0) bits.push(Math.round(kcal) + ' kcal');
  return '<div class="lrow actrow" style="cursor:default">' +
    '<div class="licon" style="background:var(--green)" aria-label="' + esc(sportName(a)) + '">' + sportIcon(a, 17) + '</div>' +
    '<div class="lbody"><div class="lrow-t">' + esc(sportName(a)) + '</div>' +
    '<div class="lrow-sub">' + esc(bits.join(' · ') || '已同步') + '</div></div></div>';
}

function renderCalendar() {
  const m = S.calMonth;
  const y = m.getFullYear(), mo = m.getMonth();
  const first = new Date(y, mo, 1);
  const startDay = addDays(first, -first.getDay());
  const rows = Math.ceil((first.getDay() + new Date(y, mo + 1, 0).getDate()) / 7);
  const actDays = new Set((S.activities || []).map(a => String(a.day).slice(0, 10)));

  const since = dataSince();
  let cells = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(startDay, i);
    const k = dayKey(d);
    const out = d.getMonth() !== mo;
    const lv = levelOf(k);
    const acts = activitiesForDay(k);
    const noData = k < since;
    const cls = ['cal-cell'];
    if (out) cls.push('out');
    if (lv) cls.push('l' + lv);
    if (k === TODAY()) cls.push('today');
    if (k === S.selDay) cls.push('sel');
    if (!out && actDays.has(k)) cls.push('hasact');
    if (noData) cls.push('nodata');
    const rate = rateOfDay(k);
    const aria = (d.getMonth() + 1) + '月' + d.getDate() + '日' +
      (rate === null ? '' : '，完成率 ' + Math.round(rate * 100) + '%') +
      (acts.length ? '，' + acts.length + ' 条运动' : '') +
      (noData ? '，超出本地数据范围' : '');
    cells += '<div class="' + cls.join(' ') + '" data-act="calday" data-id="' + k + '" ' +
      'role="button" tabindex="0" aria-label="' + aria + '"' + (noData ? ' data-nodata="1"' : '') + '>' +
      '<span class="cnum">' + d.getDate() + '</span>' +
      (!out && acts.length
        ? '<span class="act-badge">' + sportIcon(acts[0], 13) + (acts.length > 1 ? '<i>' + acts.length + '</i>' : '') + '</span>'
        : '') + '</div>';
  }

  const monthDays = [];
  for (let d = 1; d <= new Date(y, mo + 1, 0).getDate(); d++) monthDays.push(dayKey(new Date(y, mo, d)));
  const fullDays = monthDays.filter(k => levelOf(k) === 4).length;
  const anyDays = monthDays.filter(k => levelOf(k) > 0).length;
  const monthActs = monthDays.reduce((n, k) => n + activitiesForDay(k).length, 0);

  let html = '<div class="head"><div class="date">本月完成 ' + fullDays + ' 天' +
    (monthActs ? ' · 运动 ' + monthActs + ' 次' : '') +
    (S.limits && S.limits.activities ? '（仅按最近 ' + LOAD_LIMITS.activities + ' 条运动统计）' : '') +
    '</div><h2>日历</h2></div>';

  html += '<div class="cal" id="cal-box"><div class="cal-top">' +
    '<button class="m" data-act="caljump" aria-label="跳转到年月" ' +
    'style="display:flex;align-items:center;gap:4px;font-size:17px;font-weight:500">' +
    y + ' 年 ' + (mo + 1) + ' 月 ' + icon('chev', 13) + '</button>' +
    '<div class="cal-nav">' +
    '<button data-act="caltoday" aria-label="回到今天" style="width:auto;padding:0 10px;font-size:12.5px;border-radius:999px">今天</button>' +
    '<button data-act="calprev" aria-label="上个月">' + icon('left', 17) + '</button>' +
    '<button data-act="calnext" aria-label="下个月">' + icon('chev', 17) + '</button></div></div>' +
    '<div class="wk">' + WK.map(w => '<div>' + w + '</div>').join('') + '</div>' +
    '<div class="grid">' + cells + '</div>' +
    '<div class="legend"><span class="lg-act">' + icon('run', 11) + '运动类型</span><span>少</span>' +
    '<i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i>' +
    '<i style="background:var(--heat-3)"></i><i style="background:var(--blue)"></i><span>多</span></div></div>';

  const sd = parseDay(S.selDay);
  const dn = doneCount(S.selDay);
  html += '<div class="gtitle">' + (sd.getMonth() + 1) + '月' + sd.getDate() + '日 周' + WK[sd.getDay()] +
    ' · <span id="cal-progress">完成 ' + dn + '/' + dayEntries(S.selDay) + '</span></div>';
  if (!dayEntries(S.selDay)) {
    html += '<div class="card"><div class="empty">这一天还没有打卡项</div></div>';
  } else {
    /* 与首页同一套胶囊（habitChip），只是容器换成 .hchip-list 换行铺开：
       这一天有哪些卡、打没打，要一眼看全，不能靠横向滚动去翻。 */
    html += '<div class="hchip-list">' +
      habitsForDay(S.selDay).map(h => habitChip(h, S.selDay, 'daytoggle')).join('') + '</div>';
  }

  const acts = activitiesForDay(S.selDay);
  html += '<div class="gtitle" style="display:flex;justify-content:space-between;align-items:center">' +
    '<span>运动记录 · ' + acts.length + ' 条</span>' +
    '<button style="color:var(--blue);font-size:14px" data-act="corosSync">同步</button></div>';
  html += acts.length
    ? '<div class="card">' + acts.map(activityRow).join('') + '</div>'
    : '<div class="card"><div class="empty sm">这一天没有运动记录<br>' +
      '<span class="eh">连接 COROS 后，运动会自动落到对应日期</span></div></div>';

  $('#view-calendar').innerHTML = html;
}

/* ==================== 阅读与学习（合并页） ==================== */
function bookNotes(bookId) { return S.notes.filter(n => eqId(n.book_id, bookId) && !n.deleted_at); }

function renderLibrary() {
  const f = S.filter;
  const books = activeBooks();
  const list = books.filter(b => f === 'all' ? true : b.status === f);
  /* 书架只保留一种展示（三列网格）：进度、划线数都挂在格子内，
     不再另开一条横滑「继续阅读」，避免同一本书在两种尺寸下各出现一次。 */
  const plans = activePlans();
  const weekFrom = dayKey(weekStart(new Date()));
  const weekLogs = S.logs.filter(l => String(l.day).slice(0, 10) >= weekFrom).length;

  const lim = S.limits || {};
  const limTxt = [
    lim.books ? '书架仅显示最近 ' + LOAD_LIMITS.books + ' 本' : '',
    lim.notes ? '划线仅显示最近 ' + LOAD_LIMITS.notes + ' 条' : ''
  ].filter(Boolean).join(' · ');
  let html = '<div class="head"><div class="date">共 ' + books.length + ' 本 · ' +
    activeNotes().length + ' 条划线 · ' + plans.length + ' 个计划' + (limTxt ? ' · ' + limTxt : '') +
    '</div><h2>阅读与学习</h2></div>';

  /* 一行工具条：标签 + 同步按钮。原来「标签 / 统计 / 从微信读书同步 / 未配置 Key / 筛选」
     五行走完才看到书；现在统计进了页头、同步收成图标，筛选并进书架标题右边 */
  html += '<div class="lib-nav"><div class="seg">' +
    [['lib-books', '书架'], ['lib-plans', '计划']].map(x =>
      '<button class="' + (S.libSec === x[0] ? 'on' : '') + '" data-act="libsec" data-id="' +
      x[0] + '">' + x[1] + '</button>').join('') + '</div>' +
    '<button class="iconbtn" data-act="wereadsync" aria-label="从微信读书同步" title="从微信读书同步">' +
    icon('refresh', 16) + '</button></div>';

  /* ---- 左列：书架 ---- */
  let left = '<div class="sec-head"><div class="sec-t">书架 · ' + list.length + ' 本</div>' +
    '<div class="seg mini">' +
    [['all', '全部'], ['reading', '在读'], ['done', '读完']].map(x =>
      '<button class="' + (f === x[0] ? 'on' : '') + '" data-act="filter" data-id="' + x[0] + '">' + x[1] + '</button>').join('') +
    '</div></div>';
  /* 只有「没配 Key」才占一行——正常状态不该常驻一条说明 */
  if (!S.wereadKey) {
    left += '<div class="gfoot">未配置微信读书 API Key · ' +
      '<button style="color:var(--blue);font-size:12.5px" data-act="wereadsync">去配置</button></div>';
  }
  if (!list.length) {
    left += '<div class="card"><div class="empty">书架还是空的。<br>可以从微信读书粘贴导入，也可以手动添加；<br>点右上「+」→「添加书籍」即可开始。</div>' +
      '<div class="addrow" data-act="addbook">' + icon('plus', 17) + '添加书籍</div></div>';
  } else {
    left += '<div class="shelf">' + list.map(b => {
      const pr = Math.max(0, Math.min(100, Number(b.progress) || 0));
      const done = b.status === 'done';
      const n = bookNotes(b.id).length;
      return '<div class="bk" data-act="openbook" data-id="' + b.id + '">' + bookCover(b) +
        '<div class="bk-t">' + esc(b.title) + '</div>' +
        '<div class="bk-a">' + (done ? '已读完' : esc(b.author || '')) + '</div>' +
        (!done && pr > 0 ? '<div class="bk-prog" aria-hidden="true"><i style="width:' + pr + '%"></i></div>' : '') +
        (n ? '<div class="bk-a">' + n + ' 条划线</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  /* ---- 右列：学习计划 ---- */
  let planHtml = '<div class="sec-head"><div class="sec-t">学习计划 · ' + plans.length + ' 个</div>' +
    '<button style="color:var(--blue);font-size:14px" data-act="newplan">新建</button></div>';
  if (!plans.length) {
    planHtml += '<div class="card"><div class="empty">还没有学习计划。<br>建一个，比如「每周读 3 次专业书」。</div>' +
      '<div class="addrow" data-act="newplan">' + icon('plus', 17) + '新建计划</div></div>';
  } else {
    plans.forEach(p => {
      const n = logsThisWeek(p.id).length;
      const target = p.target_per_week || 3;
      const pct = Math.min(100, Math.round(n / target * 100));
      planHtml += '<div class="plan"><div class="plan-top"><div>' +
        '<div class="plan-t">' + esc(p.title) + '</div>' +
        '<div class="plan-s">每周 ' + target + ' 次' + (p.total_weeks ? ' · 共 ' + p.total_weeks + ' 周' : '') + '</div>' +
        '</div><div class="plan-pct">' + pct + '%</div></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="plan-foot"><div class="w">本周 ' + n + ' / ' + target + ' 次</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
        (loggedToday(p.id)
          ? '<button class="pill" disabled style="opacity:.45">今天已记</button>'
          : '<button class="pill" data-act="logstudy" data-id="' + p.id + '">记一次</button>') +
        '<button class="pill" style="background:var(--fill);color:var(--text-2)" data-act="delplan" data-id="' + p.id + '">删除</button>' +
        '</div></div></div>';
    });
    planHtml += '<div class="card" style="margin-top:4px"><div class="addrow" data-act="newplan">' +
      icon('plus', 17) + '新建计划</div></div>';
  }

  /* 右列只留学习计划：最近记录那一栏已按需求去掉（记录仍入库、参与本周次数统计，
     只是不再单独占一块版面） */
  html += '<div class="lib-cols"><div class="lib-left" id="lib-books">' + left + '</div>' +
    '<div class="lib-right"><div id="lib-plans">' + planHtml + '</div></div></div>';

  $('#view-library').innerHTML = html;
}

function openBook(id) {
  id = sid(id);
  const b = S.books.find(x => eqId(x.id, id) && !x.deleted_at);
  if (!b) return;
  S._openBook = id;
  const notes = bookNotes(b.id);
  const html =
    '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">书籍详情</div><button data-act="closesheet">关闭</button></div>' +
    '<div class="sheet-body">' +
    '<div style="display:flex;gap:14px;align-items:flex-start;padding:4px 0 16px">' +
    bookCover(b, true) +
    '<div style="flex:1;min-width:0">' +
    '<div style="font-size:22px;font-weight:500;line-height:1.3">' + esc(b.title) + '</div>' +
    '<div style="font-size:14px;color:var(--text-2);margin-top:4px">' + esc(b.author || '未填作者') + '</div>' +
    '<div style="font-size:12.5px;color:var(--text-3);margin-top:8px">' + (b.status === 'done' ? '已读完' : '在读') +
    ' · ' + notes.length + ' 条划线</div>' +
    '<div class="bar" style="margin:10px 0 0"><i style="width:' + Math.max(0, Math.min(100, b.progress || 0)) + '%"></i></div>' +
    '</div></div>' +
    '<div class="gtitle" style="margin-top:0">划线 · ' + notes.length + '</div>' +
    (notes.length ? notes.map(n =>
      '<div class="note"><div class="ch">' + esc(n.chapter || '') + '</div>' +
      '<div class="tx">' + esc(n.content) + '</div>' +
      '<button class="x" data-act="delnote" data-id="' + n.id + '">' + icon('x', 13) + '</button></div>').join('')
      : '<div class="empty sm">还没有划线</div>') +
    '<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">' +
    '<button class="btnblock gray" data-act="togglebookstatus" data-id="' + b.id + '">' +
    (b.status === 'done' ? '标记为在读' : '标记为读完') + '</button>' +
    '<button class="btnblock red" data-act="delbook" data-id="' + b.id + '">删除这本书</button>' +
    '</div></div>';
  openSheet(html);
}

/* ==================== 学习（工具函数，内容已并入阅读与学习页） ==================== */
function weekStart(d) { const x = new Date(d); return addDays(x, -x.getDay()); }
function logsThisWeek(planId) {
  const ws = dayKey(weekStart(new Date()));
  return S.logs.filter(l => eqId(l.plan_id, planId) && String(l.day).slice(0, 10) >= ws);
}

/* ==================== 趋势 ==================== */
function seriesDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(addDays(new Date(), -i)));
  return out;
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}
/* Fisher z 近似求双侧 p 值；正态 CDF 用 Abramowitz-Stegun 误差函数近似 */
function normCDF(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
function pValue(r, n) {
  if (n < 4 || !isFinite(r) || Math.abs(r) >= 1) return null;
  const z = 0.5 * Math.log((1 + r) / (1 - r)) * Math.sqrt(n - 3);
  return Math.max(0, Math.min(1, 2 * (1 - normCDF(Math.abs(z)))));
}
/* 睡眠是当晚的，配对「次日」完成率；无有效习惯或完全无打卡动作的次日按缺失剔除，不当 0 */
function corrPairs(days, field) {
  const f = field || 'sleep_total';
  const xs = [], ys = [];
  days.forEach(d => {
    const h = S.health[d];
    if (!h || h[f] == null) return;
    const v = Number(h[f]);
    if (!isFinite(v)) return;
    if (f === 'sleep_total' && (v <= 0 || v > 16)) return;
    const next = dayKey(addDays(parseDay(d), 1));
    const rate = rateOfDay(next);
    if (rate === null || !hasCheckins(next)) return;
    xs.push(v); ys.push(rate);
  });
  return { xs: xs, ys: ys, n: xs.length };
}

function chartSVG(days, lines, opts) {
  const o = opts || {};
  const W = 320, H = 132, PL = 8, PR = 8, PT = 10, PB = 18;
  const iw = W - PL - PR, ih = H - PT - PB;
  const n = days.length;
  const xAt = i => PL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  let out = '<svg class="chartwrap" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" ' +
    'style="height:auto" role="img" aria-label="趋势折线图">';
  for (let g = 0; g <= 3; g++) {
    const y = PT + (ih / 3) * g;
    out += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) +
      '" stroke="var(--sep)" stroke-width=".6" stroke-dasharray="2 3"/>';
  }
  const annotYs = [];
  lines.forEach((L, li) => {
    const vals = days.map(d => L.get(d));
    const vmax = L.max || 1, vmin = L.min || 0;
    let path = '', started = false, last = null;
    vals.forEach((v, i) => {
      if (v === null) { started = false; return; }
      const y = PT + ih - ((Math.max(vmin, Math.min(vmax, v)) - vmin) / (vmax - vmin || 1)) * ih;
      const x = xAt(i);
      path += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      started = true;
      last = { x: x, y: y, v: v };
    });
    if (path) out += '<path d="' + path.trim() + '" fill="none" style="stroke:' + L.color + '" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    if (o.direct !== false && last) {
      const label = L.fmt ? L.fmt(last.v) : String(Math.round(last.v * 10) / 10);
      /* 多线时保证标注之间至少 15px 间距，末端数值不再叠在一起 */
      let ty = li === 0 ? Math.max(PT + 9, last.y - 8) : Math.min(H - PB - 2, last.y + 14);
      annotYs.forEach(ay => { if (Math.abs(ty - ay) < 15) ty = Math.min(H - PB - 2, ay + 15); });
      annotYs.push(ty);
      out += '<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="2.6" fill="' + L.color + '"/>' +
        '<text class="chart-current" x="' + Math.max(PL + 12, last.x - 4).toFixed(1) + '" y="' +
        ty.toFixed(1) + '" font-size="10" font-weight="500" text-anchor="end" ' +
        'fill="' + L.color + '">' + label + '</text>';
    }
  });
  const first = parseDay(days[0]), lastDay = parseDay(days[n - 1]);
  out += '<text x="' + PL + '" y="' + (H - 4) + '" font-size="9" fill="var(--text-3)">' +
    (first.getMonth() + 1) + '/' + first.getDate() + '</text>';
  out += '<text x="' + (W - PR) + '" y="' + (H - 4) + '" font-size="9" fill="var(--text-3)" text-anchor="end">' +
    (lastDay.getMonth() + 1) + '/' + lastDay.getDate() + '</text>';
  if (o.hit) {
    const step = n > 1 ? iw / (n - 1) : iw;
    days.forEach((d, i) => {
      const x = Math.max(0, xAt(i) - step / 2);
      out += '<rect class="hit" x="' + x.toFixed(1) + '" y="0" width="' + Math.max(4, step).toFixed(1) +
        '" height="' + H + '" fill="transparent" pointer-events="all" data-act="chartday" data-id="' + d +
        '"><title>查看 ' + d + ' 的记录</title></rect>';
    });
  }
  out += '</svg>';
  return out;
}

function renderTrend() {
  const days = seriesDays(S.range);
  const rateGet = d => rateOfDay(d);
  const sleepGet = d => { const h = S.health[d]; return h && h.sleep_total != null ? Number(h.sleep_total) : null; };
  const hrvGet = d => { const h = S.health[d]; return h && h.hrv != null ? Number(h.hrv) : null; };
  const rhrGet = d => { const h = S.health[d]; return h && h.resting_hr != null ? Number(h.resting_hr) : null; };

  const rates = days.map(rateGet).filter(v => v !== null);
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const hs = days.map(sleepGet).filter(v => v !== null);
  const avgSleep = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
  const hrvs = days.map(hrvGet).filter(v => v !== null);
  const avgHrv = hrvs.length ? hrvs.reduce((a, b) => a + b, 0) / hrvs.length : null;
  const prevRate = avgMetric(rateGet, S.range, S.range);
  const prevSleep = avgMetric(sleepGet, S.range, S.range);
  const prevHrv = avgMetric(hrvGet, S.range, S.range);

  const trendHave = S.health ? Object.keys(S.health).length : 0;
  let html = '<div class="head"><div class="date">近 ' + S.range + ' 天 · ' +
    trendHave + ' 天有身体数据</div><h2>趋势</h2></div>';

  html += '<div class="seg">' + [30, 60, 90].map(n =>
    '<button class="' + (S.range === n ? 'on' : '') + '" data-act="range" data-id="' + n + '">' + n + ' 天</button>').join('') + '</div>';

  const cards = [
    { k: '打卡完成率', v: avgRate === null ? '—' : Math.round(avgRate * 100) + '<span style="font-size:15px">%</span>',
      d: rates.length + ' 天有效', cur: avgRate, prev: prevRate,
      s: seriesBack(Math.min(S.range, 30), rateGet), c: 'var(--blue)' },
    { k: '平均睡眠', v: avgSleep === null ? '—' : fmt1(avgSleep) + '<span style="font-size:15px">h</span>',
      d: hs.length + ' 天有数据', cur: avgSleep, prev: prevSleep,
      s: seriesBack(Math.min(S.range, 30), sleepGet), c: 'var(--orange)' },
    { k: '平均 HRV', v: avgHrv === null ? '—' : String(Math.round(avgHrv)) + '<span style="font-size:15px">ms</span>',
      d: hrvs.length + ' 天有数据', cur: avgHrv, prev: prevHrv,
      s: seriesBack(Math.min(S.range, 30), hrvGet), c: 'var(--green)' }
  ];
  html += '<div class="metric">' + cards.map(c =>
    '<div class="mcell"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div>' +
    cmpHTML(c.cur, c.prev, S.range) + '<div class="spark">' + sparkSVG(c.s, c.c) + '</div>' +
    '<div class="d">' + c.d + '</div></div>').join('') + '</div>';

  const mode = S.chartMode || 'rate';
  const rateLine = { get: rateGet, min: 0, max: 1, color: 'var(--blue)', fmt: v => Math.round(v * 100) + '%' };
  const sleepLine = { get: sleepGet, min: 0, max: 10, color: 'var(--orange)', fmt: v => (Math.round(v * 10) / 10).toFixed(1) + 'h' };
  const lines1 = mode === 'both' ? [rateLine, sleepLine] : (mode === 'sleep' ? [sleepLine] : [rateLine]);
  /* 图表类型不再单独占一行 seg：它就是这个图的标题，放进图卡头部右边；
     只有「叠加」时才需要图例（单序列时按钮本身就说明了画的是什么） */
  const modeSeg = '<div class="seg mini chart-seg">' +
    [['rate', '完成率'], ['sleep', '睡眠'], ['both', '叠加']].map(x =>
      '<button class="' + (mode === x[0] ? 'on' : '') + '" data-act="chartmode" data-id="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>';
  const lg1 = mode === 'both'
    ? '<div class="lg"><span><i style="background:var(--blue)"></i>完成率</span><span><i style="background:var(--orange)"></i>睡眠(h)</span></div>'
    : '';
  html += '<div class="chartcard"><div class="chart-head">' + modeSeg + lg1 + '</div>' +
    chartSVG(days, lines1, { hit: true }) + '</div>';

  const rhrs = days.map(rhrGet).filter(v => v !== null);
  const pool = hrvs.map(Number).concat(rhrs.map(Number));
  let lo = pool.length ? Math.min.apply(null, pool) : 40;
  let hi = pool.length ? Math.max.apply(null, pool) : 100;
  const padV = Math.max(3, (hi - lo) * 0.18);
  lo = Math.floor(lo - padV); hi = Math.ceil(hi + padV);

  html += '<div class="chartcard"><div class="chart-head"><div class="t">HRV 与静息心率</div>' +
    '<div class="lg"><span><i style="background:var(--green)"></i>HRV</span><span><i style="background:var(--pink)"></i>心率</span></div></div>' +
    chartSVG(days, [
      { get: hrvGet, min: lo, max: hi, color: 'var(--green)', fmt: v => String(Math.round(v)) },
      { get: rhrGet, min: lo, max: hi, color: 'var(--pink)', fmt: v => String(Math.round(v)) }
    ], { hit: true }) + '</div>';

  $('#view-trend').innerHTML = html;
}

/* ==================== 我的 ==================== */
function renderMe() {
  const u = S.user || {};
  const initial = (u.name || u.email || '·').slice(0, 1).toUpperCase();
  const coros = window.Coros ? Coros.status() : { connected: false };
  const sync = S.health[TODAY()];

  const dhHead = dataHealth();
  let html = '<div class="head"><div class="date">' +
    (dhHead.connected ? 'COROS 已连接' : 'COROS 未连接') +
    (dhHead.lastSync ? ' · 上次同步 ' + esc(dhHead.lastSync) : '') + '</div><h2>我的</h2></div>';

  html += '<div class="card"><div class="profile"><div class="avatar">' +
    (u.avatarUrl ? '<img src="' + esc(u.avatarUrl) + '" alt="">' : esc(initial)) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="n">' + esc(u.name || '已登录') + '</div>' +
    '<div class="e">' + esc(u.email || u.phone || u.id || '') + '</div></div></div>' +
    '<button class="rowbtn" data-act="copylink"><div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('link', 16) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">复制访问链接</div>' +
    '<div class="rb-s">在另一台设备打开即可登录同一账号</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button></div>';

  const dh = dataHealth();
  html += '<div class="gtitle">数据健康</div><div class="card data-health" id="data-health">' +
    '<div class="dh-title">近 7 天身体数据 ' + dh.have + '/7 天</div>' +
    '<div class="dh-bar"><i style="width:' + Math.round(dh.have / 7 * 100) + '%"></i></div>' +
    '<div class="dh-row"><span class="dk">COROS 连接</span><span class="dv">' + (dh.connected ? '已连接' : '未连接') + '</span></div>' +
    '<div class="dh-row"><span class="dk">上次同步</span><span class="dv">' + esc(dh.lastSync || '尚无记录') + '</span></div>' +
    '<div class="dh-row"><span class="dk">近 7 天运动</span><span class="dv">' + dh.acts + ' 次</span></div>' +
    '<div class="dh-row"><span class="dk">缺失身体数据</span><span class="dv">' + (7 - dh.have) + ' 天</span></div>' +
    '<div class="dh-row"><span class="dk">最近删除可恢复</span><span class="dv">' + dh.deleted + ' 项</span></div>' +
    '<div class="dh-row"><span class="dk">云端写入</span><span class="dv">' +
      (S.offline ? '离线只读' : (S.lastWriteError ? '最近一次失败' : '正常')) + '</span></div>' +
    (S.ownerId ? '<div class="dh-row"><span class="dk">数据账号</span><span class="dv">' +
      esc(S.ownerId.length > 16 ? S.ownerId.slice(0, 8) + '…' + S.ownerId.slice(-4) : S.ownerId) + '</span></div>' : '') +
    (S.loadWarnings ? '<div class="gfoot" style="margin-top:6px;padding-bottom:4px;color:var(--orange)">本次有 ' +
      S.loadWarnings + ' 张表读取失败（' +
      esc((S.loadFailed || []).map(t => LOAD_LABELS[t] || t).join('、')) +
      '），这几块显示的是上一次缓存</div>' : '') +
    (S.lastWriteError ? '<div class="gfoot" style="margin-top:6px;padding-bottom:4px;color:var(--orange)">' +
      esc(S.lastWriteError.at.slice(5, 16).replace('T', ' ')) + ' · ' + esc(S.lastWriteError.act) +
      ' · ' + esc(S.lastWriteError.message) + '</div>' : '') +
    '</div>';

  html += '<div class="gtitle">数据连接</div><div class="card">' +
    '<button class="rowbtn" data-act="corosConnect">' +
    '<div class="icbox" style="background:var(--orange)">' + icon('run', 17) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">COROS</div>' +
    '<div class="rb-s">' + (coros.connected ? ('已连接 · ' + (coros.lastSync ? '上次同步 ' + coros.lastSync : '尚未同步')) : '未连接，点此授权') + '</div></div>' +
    '<div class="dot' + (coros.connected ? '' : ' off') + '"></div></button>' +

    '<button class="rowbtn" data-act="wereadsync">' +
    '<div class="icbox" style="background:var(--teal)">' + icon('bookop', 17) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">微信读书 API</div>' +
    '<div class="rb-s">' + esc(wereadStatusText()) + (S.wereadKey ? ' · 已配置 Key' : ' · 未配置 Key') + '</div></div>' +
    '<div class="dot' + (S.wereadKey ? '' : ' off') + '"></div></button>' +
    '<button class="rowbtn" data-act="import">' +
    '<div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('pen', 16) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">粘贴划线导入</div>' +
    '<div class="rb-s">手动补充单本书的划线笔记</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +

    '<button class="rowbtn" data-act="corosSync">' +
    '<div class="icbox" style="background:var(--blue)">' + icon('refresh', 17) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">同步身体数据</div>' +
    '<div class="rb-s">' + (sync ? '今天已有数据' : '今天还没有数据') + '</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '<button class="rowbtn" data-act="corosDiag">' +
    '<div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('med', 16) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">同步诊断</div>' +
    '<div class="rb-s">' + (coros.warnCount ? '上次同步有 ' + coros.warnCount + ' 处字段未识别' : '查看上次同步结果与原始返回') + '</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '</div>';

  html += '<div class="gtitle">外观</div><div class="card">' +
    '<div class="rowbtn" style="cursor:default">' +
    '<div class="icbox" style="background:var(--indigo)">' + icon('moon', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">深色模式</div><div class="rb-s">关闭则使用浅色</div></div>' +
    '<div class="sw' + (document.documentElement.getAttribute('data-theme') === 'dark' ? ' on' : '') + '" id="sw-theme" data-act="theme"></div>' +
    '</div>' +
    '<div class="rowbtn" style="cursor:default">' +
    '<div class="icbox" style="background:var(--teal)">' + icon('drop', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">液态玻璃</div><div class="rb-s">半透明材质与镜面高光，可随时关闭</div></div>' +
    '<div class="sw' + (document.documentElement.getAttribute('data-glass') === 'on' ? ' on' : '') + '" id="sw-glass" data-act="glass"></div>' +
    '</div></div>';

  const lastExport = (function () { try { return localStorage.getItem('lb.last_export'); } catch (e) { return null; } })();
  const sinceExport = lastExport ? Math.floor((Date.now() - new Date(lastExport).getTime()) / 86400000) : null;
  html += '<div class="gtitle">数据与备份</div><div class="card">' +
    (sinceExport === null || sinceExport >= 7
      ? '<div class="rowbtn" style="cursor:default"><div style="flex:1;font-size:14px;color:var(--orange)">' +
        (sinceExport === null ? '还没有导出过备份，建议先导出一份' : '距上次导出已 ' + sinceExport + ' 天，建议重新导出') +
        '</div></div>' : '') +
    '<button class="rowbtn" data-act="exportbackup">' +
    '<div class="icbox" style="background:var(--green)">' + icon('up', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">导出备份</div><div class="rb-s">全量 JSON，不含授权令牌与 API Key</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '<button class="rowbtn" data-act="importbackup">' +
    '<div class="icbox" style="background:var(--indigo)">' + icon('refresh', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">导入恢复</div><div class="rb-s">合并缺失数据、恢复已删项，不覆盖现有内容</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '<button class="rowbtn" data-act="trash">' +
    '<div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('trash', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">最近删除</div><div class="rb-s">误删可在这里恢复</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '</div>';

  html += '<div class="gtitle">打卡项管理</div><div class="card">' +
    (activeHabits().length ? activeHabits().map(h =>
      '<div class="rowbtn" style="cursor:default">' +
      '<div class="icbox" style="background:' + esc(h.color) + '">' + icon(h.icon || 'circle', 16) + '</div>' +
      '<div style="flex:1;min-width:0"><div class="rb-t">' + esc(h.name) + '</div>' +
      '<div class="rb-s">' + esc(h.target || '每天') + '</div></div>' +
      '<button style="color:var(--red);font-size:14px;padding:6px 2px" data-act="delhabit" data-id="' + h.id + '">删除</button>' +
      '</div>').join('') : '<div class="empty sm">还没有打卡项</div>') +
    '<div class="addrow" data-act="newhabit">' + icon('plus', 17) + '新建打卡项</div></div>';

  html += '<div style="margin-top:24px"><button class="btnblock gray danger" data-act="logout">退出登录</button></div>';
  html += '<div class="gfoot" style="text-align:center;margin-top:12px">构建 ' +
    esc(window.__LB_BUILD__ || 'dev') + '</div>';

  $('#view-me').innerHTML = html;
}

/* ==================== 渲染调度 ==================== */
function render() {
  if (!S.user) return;
  if (VIEW_ALIAS[S.view]) S.view = VIEW_ALIAS[S.view];
  /* 整页重绘会丢焦点：记下当前操作元素，重绘后按同一 data-act/id/day 还原 */
  const ae = document.activeElement, keep = ae && ae.getAttribute && ae.getAttribute('data-act')
    ? { act: ae.getAttribute('data-act'), id: ae.getAttribute('data-id'), day: ae.getAttribute('data-day') } : null;
  renderChrome();
  renderFreshness();
  const map = { today: renderToday, calendar: renderCalendar, library: renderLibrary, trend: renderTrend, me: renderMe };
  VIEWS.forEach(k => { const el = $('#view-' + k); if (el) el.hidden = (S.view !== k); });
  (map[S.view] || renderToday)();
  if (keep) {
    const sel = '[data-act="' + keep.act + '"]' +
      (keep.id ? '[data-id="' + keep.id + '"]' : '') + (keep.day ? '[data-day="' + keep.day + '"]' : '');
    const again = document.querySelector(sel);
    if (again && again.focus) { try { again.focus({ preventScroll: true }); } catch (e) {} }
  }
  syncStickyBars();
  syncStripFade();
  /* 每次重绘后（写操作都会走到这里）把界面状态刷进快照，
     这样即使下次加载失败回退到快照，看到的也是刚写入的结果而不是旧数据。 */
  saveSnapshotSoon();
}

function go(view) {
  S.view = VIEW_ALIAS[view] || view;
  S.editing = false;
  /* 首次加载时切页给骨架，不再白屏 */
  if (S.loading) {
    renderChrome();
    VIEWS.forEach(k => { const el = $('#view-' + k); if (el) el.hidden = (S.view !== k); });
    renderSkeleton(S.view);
  } else render();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ==================== 弹层 ==================== */
let sheetReturnFocus = null;
function openSheet(html) {
  if (!$('#mask').classList.contains('on')) {
    const ae = document.activeElement;
    sheetReturnFocus = (ae && ae !== document.body && ae.focus) ? ae : null;
  }
  $('#sheet').innerHTML = html;
  $('#mask').classList.add('on');
}
function closeSheet() {
  $('#mask').classList.remove('on');
  setTimeout(() => { if (!$('#mask').classList.contains('on')) $('#sheet').innerHTML = ''; }, 300);
  if (sheetReturnFocus && sheetReturnFocus.focus) {
    try { sheetReturnFocus.focus({ preventScroll: true }); } catch (e) {}
  }
  sheetReturnFocus = null;
}

/* iOS 风格确认弹层，替代原生 confirm()；返回 Promise<boolean> */
let confirmReturnFocus = null;
function askConfirm(opts) {
  return new Promise(function (resolve) {
    const m = $('#confirm-mask');
    if (!m) { resolve(false); return; }
    $('#a-title').textContent = opts.title || '确认操作';
    $('#a-msg').textContent = opts.message || '';
    const okBtn = $('#a-ok'), cancelBtn = $('#a-cancel');
    okBtn.textContent = opts.okText || '删除';
    okBtn.className = 'a-btn ' + (opts.danger === false ? 'blue' : 'danger');
    const ae = document.activeElement;
    confirmReturnFocus = (ae && ae !== document.body && ae.focus) ? ae : null;
    m.classList.add('on');
    /* 键盘与读屏：默认焦点落在「取消」上，误触不会直接删数据 */
    setTimeout(function () {
      try { (opts.danger === false ? okBtn : cancelBtn).focus(); } catch (e) {}
    }, 30);
    function done(v) {
      m.classList.remove('on');
      okBtn.onclick = null; cancelBtn.onclick = null; m.onclick = null;
      const back = confirmReturnFocus; confirmReturnFocus = null;
      if (back && back.focus) { try { back.focus({ preventScroll: true }); } catch (e) {} }
      resolve(v);
    }
    okBtn.onclick = function () { done(true); };
    cancelBtn.onclick = function () { done(false); };
    m.onclick = function (e) { if (e.target === m) done(false); };
  });
}
/* 离线时禁止一切写库 / 授权动作，只保留浏览与导出 */
/* toggle/daytoggle 不在这里：打卡支持离线队列，由 toggleCheckin 自己判断 */
const WRITE_ACTS = new Set(['savehabit', 'delhabit', 'savemanualbook',
  'delnote', 'delbook', 'togglebookstatus', 'saveplan', 'logstudy', 'delplan', 'doimport',
  'corosConnect', 'corosSync', 'restore', 'importbackup', 'undo',
  'savewereadkey', 'doweresync', 'doshelfimport']);

/* ==================== 新建/编辑打卡项 ==================== */
const ICON_CHOICES = ['sun', 'book', 'run', 'med', 'pen', 'drop', 'bed', 'heart', 'flame', 'scale'];
const COLOR_CHOICES = ['#FF9F0A', '#0A84FF', '#30D158', '#5E5CE6', '#BF5AF2', '#FF375F', '#40C8E0', '#8E8E93'];

function openHabitSheet(editId) {
  const h = editId ? S.habits.find(x => eqId(x.id, editId)) : null;
  const curIcon = h ? h.icon : 'sun';
  const curColor = h ? h.color : '#0A84FF';
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">' + (h ? '编辑打卡项' : '新建打卡项') + '</div>' +
    '<button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body">' +
    '<div class="card" style="padding:14px">' +
    '<input type="text" id="ah-name" placeholder="名称，例如「早起 6:30」" value="' + (h ? esc(h.name) : '') + '">' +
    '<div class="lbl">频率</div>' +
    '<input type="text" id="ah-target" placeholder="例如 每天 / 每周 4 次 / 工作日" value="' + (h ? esc(h.target || '') : '每天') + '">' +
    '</div>' +
    '<div class="lbl">图标</div><div class="picks" id="p-icon">' +
    ICON_CHOICES.map(k => '<button class="pick' + (k === curIcon ? ' on' : '') + '" data-pick="icon" data-v="' + k + '" ' +
      'style="background:' + curColor + '">' + icon(k, 18) + '</button>').join('') + '</div>' +
    '<div class="lbl">颜色</div><div class="picks" id="p-color">' +
    COLOR_CHOICES.map(c => '<button class="swatch' + (c === curColor ? ' on' : '') + '" data-pick="color" data-v="' + c + '" ' +
      'style="background:' + c + '"></button>').join('') + '</div>' +
    '<div style="margin-top:20px"><button class="btnblock blue" data-act="savehabit" data-id="' + (h ? h.id : '') + '">' +
    (h ? '保存' : '添加') + '</button></div></div>';
  openSheet(html);
  window.__pickIcon = curIcon;
  window.__pickColor = curColor;
  if (!h) {
    const d = draftGet('habit');
    if (d) {
      if ($('#ah-name')) $('#ah-name').value = d['ah-name'] || '';
      if ($('#ah-target')) $('#ah-target').value = d['ah-target'] || '每天';
    }
  }
}

async function submitHabit(editId) {
  const name = ($('#ah-name') && $('#ah-name').value || '').trim();
  if (!name) { toast('请填写名称'); return; }
  const target = ($('#ah-target') && $('#ah-target').value || '').trim() || '每天';
  const payload = { name: name, target: target, icon: window.__pickIcon || 'sun', color: window.__pickColor || '#0A84FF' };
  try {
    await saveHabit(payload, editId || null);
    draftClear('habit');
    closeSheet();
    toast(editId ? '已保存' : '已添加');
  } catch (e) {
    noteWriteError('savehabit', e);
    toast('保存失败：' + (e.message || '网络异常') + (e.needRelogin ? '。请重新登录' : ''), null, 6000);
  }
}

/* ==================== 添加书籍 ==================== */
function openAddBookSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">添加 / 同步</div><button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body">' +
    '<div class="card">' +
    '<button class="rowbtn" data-act="wereadsync"><div class="icbox" style="background:var(--teal)">' + icon('refresh', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">从微信读书 API 同步书架</div><div class="rb-s">' + esc(wereadStatusText()) + ' · 推荐</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '<button class="rowbtn" data-act="import"><div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('bookop', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">粘贴划线导入</div><div class="rb-s">手动补充单本书的划线笔记</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '<button class="rowbtn" data-act="manualbook"><div class="icbox" style="background:var(--blue)">' + icon('pen', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">手动添加</div><div class="rb-s">只填书名和作者</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button>' +
    '</div></div>';
  openSheet(html);
}

function openManualBookSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">手动添加</div><button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body"><div class="card" style="padding:14px">' +
    '<input type="text" id="mb-title" placeholder="书名">' +
    '<div class="lbl">作者</div>' +
    '<input type="text" id="mb-author" placeholder="作者（可留空）">' +
    '</div><div style="margin-top:18px"><button class="btnblock blue" data-act="savemanualbook">添加</button></div></div>';
  openSheet(html);
  const d = draftGet('book');
  if (d) {
    if ($('#mb-title')) $('#mb-title').value = d['mb-title'] || '';
    if ($('#mb-author')) $('#mb-author').value = d['mb-author'] || '';
  }
}

async function submitManualBook() {
  const t = ($('#mb-title') && $('#mb-title').value || '').trim();
  if (!t) { toast('请填写书名'); return; }
  const a = ($('#mb-author') && $('#mb-author').value || '').trim();
  if (activeBooks().some(b => normTitle(b.title) === normTitle(t))) {
    toast('这本已经在书架里了'); return;
  }
  try {
    await saveBook({ title: t, author: a || null, status: 'reading', progress: 0, source: 'manual' });
    draftClear('book');
    closeSheet(); toast('已添加');
  } catch (e) {
    toast(e.duplicateBook ? '这本已经在书架里了' : '添加失败：' + (e.message || '网络异常'));
  }
}

/* ==================== 学习计划 ==================== */
function openPlanSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">新建学习计划</div><button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body"><div class="card" style="padding:14px">' +
    '<input type="text" id="pl-title" placeholder="计划名称，例如「每周读 3 次专业书」">' +
    '<div class="lbl">每周目标次数</div>' +
    '<input type="number" id="pl-target" value="3" min="1" max="21" inputmode="numeric">' +
    '<div class="lbl">总周数（可留空）</div>' +
    '<input type="number" id="pl-weeks" placeholder="例如 12" min="1" inputmode="numeric">' +
    '</div><div style="margin-top:18px"><button class="btnblock blue" data-act="saveplan">创建</button></div></div>';
  openSheet(html);
  const d = draftGet('plan');
  if (d) {
    if ($('#pl-title')) $('#pl-title').value = d['pl-title'] || '';
    if ($('#pl-target')) $('#pl-target').value = d['pl-target'] || '3';
    if ($('#pl-weeks')) $('#pl-weeks').value = d['pl-weeks'] || '';
  }
}

async function submitPlan() {
  const t = ($('#pl-title') && $('#pl-title').value || '').trim();
  if (!t) { toast('请填写计划名称'); return; }
  const tg = parseInt(($('#pl-target') && $('#pl-target').value) || '3', 10) || 3;
  const w = parseInt(($('#pl-weeks') && $('#pl-weeks').value) || '0', 10) || null;
  try {
    await savePlan({ title: t, target_per_week: tg, total_weeks: w, sort_order: activePlans().length });
    draftClear('plan');
    closeSheet(); toast('已创建');
  } catch (e) { toast('创建失败：' + (e.message || '网络异常')); }
}

/* ==================== 微信读书导入 ==================== */
function openImportSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">从微信读书导入</div><button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body">' +
    '<div class="gfoot" style="margin:0 4px 10px">在微信读书里选中一段划线，复制后粘贴到这里。第一行写书名（可选，格式「书名 - 作者」），下面每条划线换行即可。也支持粘贴整页笔记。</div>' +
    '<textarea id="wr-text" placeholder="反脆弱 - 塔勒布&#10;允许自己犯错，是反脆弱的第一步。&#10;系统的韧性来自冗余。"></textarea>' +
    '<div style="margin-top:12px"><button class="btnblock blue" data-act="doimport">解析并导入</button></div>' +
    '<div style="text-align:center;margin-top:10px"><button style="color:var(--blue);font-size:14px" data-act="demofill">填入一段示例</button></div>' +
    '</div>';
  openSheet(html);
}

async function doImport() {
  const raw = ($('#wr-text') && $('#wr-text').value || '').trim();
  if (!raw) { toast('请先粘贴内容'); return; }
  const parsed = window.Weread ? Weread.parse(raw) : { title: '', author: '', notes: [] };
  if (!parsed.notes.length) { toast('没有解析到划线内容'); return; }
  try {
    let book = parsed.title ? activeBooks().find(b => normTitle(b.title) === normTitle(parsed.title)) : null;
    if (!book) {
      book = await saveBook({
        title: parsed.title || '未命名书籍',
        author: parsed.author || null,
        status: 'reading', progress: 0, source: 'weread'
      });
    }
    const rows = parsed.notes.map(n => ({
      book_id: book.id,
      chapter: n.chapter || null,
      content: n.text,
      external_id: null
    }));
    const res = await addNotes(rows);
    closeSheet();
    toast('「' + book.title + '」新增 ' + res.added + ' 条划线' +
      (res.skipped ? '，跳过 ' + res.skipped + ' 条重复' : ''));
  } catch (e) { toast('导入失败：' + (e.message || '网络异常')); }
}

/* ==================== 微信读书 API 同步 ==================== */
const WEREAD_HINT = '同步微信读书书架';

async function loadWereadState() {
  try {
    const cfg = await kvGet('weread_api_key');
    S.wereadKey = cfg && cfg.key ? String(cfg.key) : '';
    const st = await kvGet('weread_last_sync');
    S.wereadSyncAt = st && st.at ? String(st.at) : null;
  } catch (e) { /* app_kv 读不到时保持默认，不阻断启动 */ }
}

function wereadStatusText() {
  if (!S.wereadSyncAt) return '尚未同步';
  const d = new Date(S.wereadSyncAt);
  if (isNaN(d.getTime())) return '已同步';
  return '上次同步 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function openWereadSyncSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">微信读书同步</div><button data-act="closesheet">关闭</button></div>' +
    '<div class="sheet-body">' +
    '<div class="gfoot" style="margin:0 4px 12px">书架来自官方 Agent API（/shelf/sync）。' +
    '该网关只放行 weread.qq.com 跨域，网页直连几乎都会被拦截，所以推荐下面两种方式。</div>' +
    '<div class="card" style="padding:14px">' +
    '<div class="lbl" style="margin-top:0">方式 1 · 粘贴 /shelf/sync 的响应</div>' +
    '<textarea id="wr-shelf" placeholder=\'{"books":[{"bookInfo":{"title":"书名","author":"作者"},"progress":35}]}\'></textarea>' +
    '<div style="margin-top:10px"><button class="btnblock blue" data-act="doshelfimport">解析并同步书架</button></div>' +
    '</div>' +
    '<div class="card" style="padding:14px;margin-top:10px">' +
    '<div class="lbl" style="margin-top:0">方式 2 · 让 WorkBuddy 服务端代拉</div>' +
    '<div class="gfoot" style="margin:0 0 10px">复制下面这句，在 WorkBuddy 对话里发送；服务端拉到书架后会写进你的云端账户。</div>' +
    '<button class="btnblock gray" data-act="copyweresync">复制同步指令</button>' +
    '</div>' +
    '<details class="adv"><summary>高级 · 浏览器直连（多数网络会被跨域拦截）</summary>' +
    '<div class="card" style="padding:14px;margin-top:10px">' +
    '<div class="lbl" style="margin-top:0">API Key（wrk- 开头，只保存在你的云端账户）</div>' +
    '<input type="text" id="wr-key" placeholder="wrk-…" value="' + esc(S.wereadKey || '') + '">' +
    '<div style="margin-top:10px"><button class="btnblock gray" data-act="savewereadkey">保存 Key</button></div>' +
    '<div style="margin-top:8px"><button class="btnblock gray" data-act="doweresync">立即从 API 同步（实验）</button></div>' +
    '</div></details>' +
    '<div class="gfoot" style="margin:12px 4px 0">' + esc(wereadStatusText()) +
    ' · 当前书架 ' + activeBooks().length + ' 本</div>' +
    '</div>';
  openSheet(html);
}

async function saveWereadKey() {
  const key = ($('#wr-key') && $('#wr-key').value || '').trim();
  if (!key) { toast('请填写 API Key'); return; }
  try {
    await kvSet('weread_api_key', { key: key });
    S.wereadKey = key;
    toast('API Key 已保存');
  } catch (e) { noteWriteError('savewereadkey', e); toast('保存失败：' + (e.message || ''), null, 6000); }
}

/* 把 API 书架合并进云端：按 external_id（bookId）优先、书名兜底去重，
   已有书只补作者/来源/进度，绝不覆盖手动标记或删除状态。 */
async function applyShelf(list) {
  let added = 0, updated = 0;
  for (const b of list) {
    const hit = activeBooks().find(x =>
      (b.external_id && x.external_id && String(x.external_id) === String(b.external_id)) ||
      normTitle(x.title) === normTitle(b.title));
    if (hit) {
      const patch = { source: 'weread' };
      if (b.author && !hit.author) patch.author = b.author;
      if (b.external_id && !hit.external_id) patch.external_id = b.external_id;
      if (b.status !== hit.status) { patch.status = b.status; patch.progress = b.progress; }
      if (Object.keys(patch).length > 1) { await patchBook(hit.id, patch); updated++; }
    } else {
      try {
        await saveBook({
          title: b.title, author: b.author, status: b.status,
          progress: b.progress, source: 'weread', external_id: b.external_id
        });
        added++;
      } catch (e) {
        /* 抓到本地缓存里还没有、但库里已存在的同名书：不算失败 */
        if (e.duplicateBook) updated++; else throw e;
      }
    }
  }
  const at = new Date().toISOString();
  await kvSet('weread_last_sync', { at: at, count: list.length, added: added, updated: updated });
  S.wereadSyncAt = at;
  await loadAll(); render(); closeSheet();
  toast('已同步 ' + list.length + ' 本 · 新增 ' + added + ' · 更新 ' + updated);
  return { added: added, updated: updated };
}

async function runWereadSync() {
  if (!window.Weread || !Weread.fetchShelf) { toast('同步模块未就绪'); return; }
  const key = ($('#wr-key') && $('#wr-key').value || '').trim() || S.wereadKey;
  if (!key) { toast('请先填写并保存 API Key'); return; }
  toast('正在从微信读书同步…');
  try {
    const list = await Weread.fetchShelf(key);
    await applyShelf(list);
  } catch (e) {
    noteWriteError('doweresync', e);
    toast('浏览器直连失败（网关 CORS 限制）。请在 WorkBuddy 里发送「' + WEREAD_HINT +
      '」，或粘贴 API 响应 JSON。', null, 7000);
  }
}

async function doShelfImport() {
  const raw = ($('#wr-shelf') && $('#wr-shelf').value || '').trim();
  if (!raw) { toast('请先粘贴 API 响应'); return; }
  const list = window.Weread ? Weread.parseShelf(raw) : [];
  if (!list.length) { toast('没有解析到书籍，请检查 JSON 格式'); return; }
  try { await applyShelf(list); }
  catch (e) { noteWriteError('doshelfimport', e); toast('同步失败：' + (e.message || ''), null, 6000); }
}

async function copyWereadSyncHint() {
  try { await navigator.clipboard.writeText(WEREAD_HINT); toast('已复制，粘贴到 WorkBuddy 对话即可同步'); }
  catch (e) { toast('请手动复制：' + WEREAD_HINT, null, 6000); }
}

/* ==================== 动作分发 ==================== */
document.addEventListener('click', async function (ev) {
  const el = ev.target.closest('[data-act]');
  if (!el) {
    if (ev.target.id === 'mask') closeSheet();
    return;
  }
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  const eid = sid(id);          // 实体主键一律按字符串匹配
  const day = el.getAttribute('data-day');

  if (WRITE_ACTS.has(act) && !(await writeGuard(act))) return;

  // 选择器类
  if (el.hasAttribute('data-pick')) {
    const kind = el.getAttribute('data-pick'), v = el.getAttribute('data-v');
    const box = el.parentElement;
    Array.from(box.children).forEach(c => c.classList.remove('on'));
    el.classList.add('on');
    if (kind === 'icon') {
      window.__pickIcon = v;
      $$('#p-icon .pick').forEach(b => b.style.background = window.__pickColor || '#0A84FF');
    } else {
      window.__pickColor = v;
      $$('#p-icon .pick').forEach(b => b.style.background = v);
    }
    return;
  }

  switch (act) {
    case 'tab': go(id); break;
    case 'filter': S.filter = id; render(); break;
    case 'range': S.range = parseInt(id, 10) || 30; render(); break;
    case 'theme': toggleTheme(); render(); break;
    case 'glass': toggleGlass(); render(); break;
    case 'chartmode': S.chartMode = id; render(); break;
    case 'healthdetail': S.sparkField = (S.sparkField === eid ? null : eid); render(); break;

    case 'quick': openQuickSheet(); break;
    case 'quickgo': {
      const doIt = el.getAttribute('data-do');
      if (S.offline && ['newhabit', 'addbook', 'newplan', 'logfirst', 'corosSync'].indexOf(doIt) >= 0) {
        noteWriteError('quickgo:' + doIt, new Error('离线只读模式，操作未执行'));
        toast('当前是离线只读模式，联网后刷新页面再试', null, 6000); break;
      }
      closeSheet();
      if (doIt === 'newhabit') openHabitSheet(null);
      else if (doIt === 'addbook') openAddBookSheet();
      else if (doIt === 'newplan') openPlanSheet();
      else if (doIt === 'logfirst') {
        const p = activePlans()[0];
        if (p) await logStudy(p.id); else toast('还没有学习计划');
      }
      else if (doIt === 'corosSync') await runCorosSync();
      else if (doIt === 'caltoday') {
        S.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        S.selDay = TODAY(); go('calendar');
      }
      else if (doIt === 'theme') { toggleTheme(); render(); }
      else if (doIt.indexOf('tab:') === 0) go(doIt.slice(4));
      break;
    }
    case 'undo': {
      const item = undoStack.pop();
      if (item) { try { await item.fn(); } catch (e) { toast('撤销失败：' + ((e && e.message) || '')); } }
      break;
    }

    case 'toggle':
      if (S.editing) break;
      await toggleCheckin(eid, day || TODAY(), true);
      patchCheckinUI(eid, day || TODAY(), 'toggle');
      break;
    case 'daytoggle':
      await toggleCheckin(eid, day || S.selDay, true);
      patchCheckinUI(eid, day || S.selDay, 'daytoggle');
      break;
    case 'edittoggle': S.editing = !S.editing; render(); break;

    case 'calprev': swipeMonth(-1); break;
    case 'calnext': swipeMonth(1); break;
    case 'caltoday':
      S.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      S.selDay = TODAY(); render(); break;
    case 'caljump': openCalJumpSheet(); break;
    case 'calgo': {
      const y = parseInt(($('#cj-year') && $('#cj-year').value) || String(new Date().getFullYear()), 10);
      const m = parseInt(($('#cj-month') && $('#cj-month').value) || '1', 10);
      S.calMonth = new Date(y, m - 1, 1);
      S.selDay = dayKey(new Date(y, m - 1, 1));
      closeSheet(); render(); break;
    }
    case 'calday':
      if (el.hasAttribute('data-nodata')) { toast('该日期早于本地数据范围（近 400 天）'); break; }
      S.selDay = id; render(); break;
    case 'chartday': {
      const d = parseDay(id);
      S.selDay = id;
      S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      go('calendar'); break;
    }
    case 'libsec': {
      S.libSec = id;
      $$('.lib-nav button').forEach(b => b.classList.toggle('on', b.getAttribute('data-id') === id));
      const t = document.getElementById(id);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }

    case 'newhabit': openHabitSheet(null); break;
    case 'savehabit': await submitHabit(eid || null); break;
    case 'delhabit': {
      const h = S.habits.find(x => eqId(x.id, eid));
      if (!(await askConfirm({
        title: '删除打卡项',
        message: '删除「' + (h ? h.name : '') + '」？历史打卡记录会保留，用于计算完成率。',
        okText: '删除'
      }))) break;
      try { await removeHabit(eid); toast('已删除', undoDelete('habit', eid, '打卡项')); }
      catch (e) { toast('删除失败：' + (e.message || '')); }
      break;
    }

    case 'addbook': openAddBookSheet(); break;
    case 'manualbook': openManualBookSheet(); break;
    case 'savemanualbook': await submitManualBook(); break;
    case 'openbook': openBook(eid); break;
    case 'delnote': {
      ev.stopPropagation();
      try {
        await removeNote(eid);
        if (S._openBook) openBook(S._openBook); else closeSheet();
        toast('已删除划线', undoDelete('note', eid, '划线'));
      } catch (e) { toast('删除失败：' + (e.message || '')); }
      break;
    }
    case 'delbook': {
      const b = S.books.find(x => eqId(x.id, eid));
      if (!(await askConfirm({
        title: '删除这本书',
        message: '「' + (b ? b.title : '') + '」及其划线会移入「最近删除」，可随时恢复。',
        okText: '删除'
      }))) break;
      try { await removeBook(eid); closeSheet(); toast('已删除', undoDelete('book', eid, '书籍')); }
      catch (e) { toast('删除失败：' + (e.message || '')); }
      break;
    }
    case 'togglebookstatus': {
      const b = S.books.find(x => eqId(x.id, eid));
      if (!b) break;
      try {
        await patchBook(eid, { status: b.status === 'done' ? 'reading' : 'done', progress: b.status === 'done' ? 0 : 100 });
        openBook(eid); toast('已更新');
      } catch (e) { toast('更新失败：' + (e.message || '')); }
      break;
    }

    case 'newplan': openPlanSheet(); break;
    case 'saveplan': await submitPlan(); break;
    case 'logstudy':
      try { await logStudy(eid); } catch (e) { toast('记录失败：' + (e.message || '')); }
      break;
    case 'delplan': {
      try { await removePlan(eid); toast('已删除计划', undoDelete('plan', eid, '计划')); }
      catch (e) { toast('删除失败：' + (e.message || '')); }
      break;
    }

    case 'import': openImportSheet(); break;
    case 'doimport': await doImport(); break;
    case 'wereadsync': openWereadSyncSheet(); break;
    case 'savewereadkey': await saveWereadKey(); break;
    case 'doweresync': await runWereadSync(); break;
    case 'doshelfimport': await doShelfImport(); break;
    case 'copyweresync': await copyWereadSyncHint(); break;
    case 'demofill': {
      const ta = $('#wr-text');
      if (ta) ta.value = '反脆弱 - 塔勒布\n允许自己犯错，是反脆弱的第一步。\n系统的韧性来自冗余，而不是精确。\n我们高估了知识，低估了行动。';
      break;
    }

    case 'corosConnect':
      if (window.Coros) await Coros.connect();
      break;
    case 'corosSync': await runCorosSync(); break;
    case 'reloadall': await reloadAll(); break;
    case 'corosDiag': {
      const w = (window.Coros && typeof Coros.warnings === 'function') ? Coros.warnings() : [];
      const diag = (window.Coros && typeof Coros.diagnostics === 'function') ? await Coros.diagnostics() : null;
      let html = '<div class="grabber"></div><div class="sheet-h"><div class="t">同步诊断</div>' +
        '<button data-act="closesheet">关闭</button></div><div class="sheet-body">';
      html += '<div class="gfoot" style="margin:0 4px 12px">' +
        (diag
          ? ('上次运行 ' + esc(String(diag.at || '').slice(0, 19).replace('T', ' ')) + ' · ' +
             (diag.ok ? '成功' : '失败') +
             (diag.parsed ? ' · ' + diag.parsed.healthDays + ' 天身体数据 / ' + diag.parsed.activities + ' 条运动' : ''))
          : '还没有同步记录。') + '</div>';
      if (diag && diag.ok === false && diag.error) {
        html += '<div class="gtitle">失败原因</div><div class="card" style="padding:14px">' +
          '<div style="font-size:14px;color:var(--red);line-height:1.6">' + esc(diag.error) + '</div></div>';
      }
      if (w.length) {
        html += '<div class="gtitle">未识别字段（' + w.length + '）</div>' + w.map(x =>
          '<div class="note"><div class="ch">' + esc(x.tool || '未知工具') + ' · ' + esc(x.field || '') + '</div>' +
          '<div class="tx">' + esc(x.reason) + '</div></div>').join('');
      }
      if (diag && Array.isArray(diag.log) && diag.log.length) {
        html += '<div class="gtitle">调用日志</div><div class="card">' + diag.log.map(x =>
          '<div class="lrow" style="cursor:default"><div class="lbody">' +
          '<div class="lrow-t" style="font-size:12.5px">' + esc(String(x)) + '</div></div></div>').join('') + '</div>';
      }
      if (diag && Array.isArray(diag.samples) && diag.samples.length) {
        html += '<div class="gtitle">原始返回样本</div>' + diag.samples.map(x =>
          '<div class="note"><div class="ch">' + esc(x.tool || '') + ' · ' + esc(x.kind || '') + '</div>' +
          '<div class="tx" style="font-size:12.5px;white-space:pre-wrap;word-break:break-all">' +
          esc(String(x.preview || '')) + '</div></div>').join('');
      }
      if (!w.length && !(diag && diag.log && diag.log.length)) {
        html += '<div class="empty sm">上次同步没有未识别字段。</div>';
      }
      html += '</div>';
      openSheet(html);
      break;
    }

    case 'trash': openTrashSheet(); break;
    case 'restore': {
      try {
        await restoreRow(el.getAttribute('data-kind'), eid);
        openTrashSheet();
        toast('已恢复');
      } catch (e) { toast('恢复失败：' + (e.message || '')); }
      break;
    }
    case 'exportbackup': {
      try { await exportBackup(); renderMe(); }
      catch (e) { toast('导出失败：' + (e.message || '')); }
      break;
    }
    case 'importbackup': {
      const bf = $('#backup-file');
      if (bf) bf.click();
      break;
    }

    case 'closesheet': closeSheet(); break;
    case 'copylink':
      try { await navigator.clipboard.writeText(appBase()); toast('访问链接已复制'); }
      catch (e) { toast('复制失败，请手动复制地址栏'); }
      break;
    case 'logout': {
      if (!(await askConfirm({
        title: '退出登录', message: '退出后需要重新登录才能同步数据。本机的缓存会一并清除。',
        okText: '退出登录', danger: false
      }))) break;
      try { await cloud.auth.signOut(); } catch (e) {}
      dropCookie(SESSION_COOKIE);     // 主动退出时不能留下可复原的会话
      clearLocalData();               // 换账号前必须丢掉上一个人的快照与离线队列
      location.reload();
      break;
    }
  }
});

/* ==================== 鉴权 & 启动 ==================== */
function showLogin(msg) {
  $('#main').hidden = true;
  $('#login-view').hidden = false;
  const e = $('#login-err');
  if (msg) { e.hidden = false; e.textContent = msg; } else { e.hidden = true; }
}

async function enterApp(session) {
  S.user = session.user || {};
  persistSession();                       // 登录成功立刻把会话镜像进 cookie
  $('#login-view').hidden = true;
  $('#main').hidden = false;
  S.loading = true;
  renderChrome();
  renderSkeleton(S.view);                 // 首屏不再是空白
  const snap = readSnapshot();
  if (snapMismatch) clearLocalData();   // 快照属于另一个账号：直接丢弃，不进内存
  if (snap) { applySnapshot(snap, false); render(); }   // 先用本地快照给出可见内容
  if (navigator.onLine === false) {
    S.loading = false;
    if (snap) { applySnapshot(snap); render(); toast('离线模式 · 正在显示本机缓存数据'); return; }
  }
  try {
    await loadAll();
    await loadWereadState();
    S.offline = false;
    S.loading = false;
    saveSnapshot();
    render();
    if (window.Coros) { try { await Coros.afterLogin(); } catch (e) {} }
    // 先把上次离线攒下的打卡补传，再重载一次让界面与云端一致
    const f = await flushPending();
    if (f.ok) { try { await loadAll(); saveSnapshot(); render(); } catch (e) {} }
    /* 每天首次打开：静默同步 COROS，成功后自动重载，展示当天最新数据。
       不 await，避免拖慢首屏；失败只记诊断，不打断使用。 */
    syncCorosDaily();
  } catch (e) {
    S.loading = false;
    /* 只有真正的网络问题才进入离线模式；服务端报错/数据异常不能被误标成离线，
       否则 autoRefresh 会一直跳过，页面永远停在只读。 */
    const net = navigator.onLine === false ||
      /failed to fetch|networkerror|network error|timeout|load failed|aborted/i.test(String((e && e.message) || e));
    S.offline = net;
    console.error('[load] failed', e);
    if (snap && applySnapshot(snap, net)) {
      render();
      toast(net ? '离线模式 · 正在显示本机缓存数据'
                : '数据加载失败：' + ((e && e.message) || '未知原因') + ' · 正在显示本机缓存', null, 6000);
    } else {
      renderChrome();
      $('#view-today').innerHTML = '<div class="empty tall">' +
        (net ? '离线，且本机还没有缓存' : '数据加载失败') +
        '<br><span class="eh">' + esc(e && e.message || '网络异常') +
        '</span><br><br><button class="pill" onclick="location.reload()">重试</button></div>';
    }
  }
}

/* iOS 大标题：滚动后收起为内联标题，导航栏才出现材质与滚动边缘分隔 */
/* 横排打卡条：只在不溢出时才不该有渐隐提示，所以每次重绘/滚动后重算 */
function syncStripFade() {
  /* 横向滚动区统一处理：打卡胶囊、在读封面。溢出时右缘渐隐提示"还能滑"，
     滑到末尾撤掉，避免最后一项被虚化。 */
  $$('.habit-strip, .rail.sm').forEach(el => {
    const over = el.scrollWidth - el.clientWidth > 4;
    el.classList.toggle('scrollable', over);
    el.classList.toggle('at-end', over && el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  });
}

/* 顶栏与书架吸顶工具条的材质开关：重绘后也要重算，否则停在半途会丢材质 */
function syncStickyBars() {
  const nav = $('.navbar');
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  if (nav) nav.classList.toggle('scrolled', y > 24);
  const ln = $('.lib-nav');
  if (ln) ln.classList.toggle('stuck', ln.getBoundingClientRect().top <= 53);
}
function initNavScroll() {
  if (!$('.navbar')) return;
  let queued = false;
  window.addEventListener('scroll', function () {
    if (!queued) { queued = true; requestAnimationFrame(function () { syncStickyBars(); queued = false; }); }
  }, { passive: true });
  window.addEventListener('resize', syncStickyBars, { passive: true });
  document.addEventListener('scroll', function (e) {
    if (e.target && e.target.classList && (e.target.classList.contains('habit-strip') || e.target.classList.contains('rail'))) syncStripFade();
  }, true);
  syncStickyBars();
}

/* COROS 把今天的数据写进云端后，页面可能还停在旧的内存快照；
   回到前台时若今天没有身体数据，静默重新拉一次（60 秒节流）。 */
let lastAutoRefresh = 0, lastOfflineRetry = 0, refreshing = false;
/* 刷新串行化：离线队列回放与全量拉取必须按顺序走，否则会重复拉取、重复提示 */
async function refreshAll() {
  if (!S.user || refreshing) return { skipped: true };
  refreshing = true;
  try {
    const f = await flushPending();
    await loadAll();                 // 成功会把 S.offline 复位
    saveSnapshot(); render();
    return f;
  } catch (e) {
    /* 后台刷新失败也要落一次渲染：否则界面停在旧数据上，而「哪块没更新」
       的提示只在 render 里出现，用户会以为刚才那一眼就是最新状态。 */
    S.offline = navigator.onLine === false ||
      /failed to fetch|networkerror|network error|timeout|load failed|aborted/i.test(String((e && e.message) || ''));
    try { render(); } catch (x) {}
    return { error: e };
  } finally {
    refreshing = false;
  }
}
/* 回到前台时全量刷新：另一台设备新增的书/计划也能及时出现。
   正在填表单或弹层打开时跳过，避免打断输入。
   离线态也允许重试（30 秒节流），否则一次失败会把页面闩死在只读。 */
async function autoRefreshToday(force) {
  if (!S.user || refreshing) return;
  if ($('#mask') && $('#mask').classList.contains('on')) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  if (S.offline) {
    if (!force && Date.now() - lastOfflineRetry < 30000) return;
    lastOfflineRetry = Date.now();
  } else {
    if (!force && Date.now() - lastAutoRefresh < 60000) return;
    lastAutoRefresh = Date.now();
  }
  await refreshAll();
  syncCorosDaily();               // 跨过零点后重新回到前台，也算「当天首次打开」
}
function initAutoRefresh() {
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') autoRefreshToday();
    else flushSnapshotNow();          // 切走前把防抖中的快照落盘，iOS 可能就此冻结页面
  });
  window.addEventListener('pagehide', flushSnapshotNow);
  window.addEventListener('focus', autoRefreshToday);
  window.addEventListener('online', function () {
    if (!S.user) return;
    S.offline = false;
    autoRefreshToday(true);      // 先回放离线队列，再全量刷新（串行，不并发）
  });
  /* 看门狗：应用常驻不切后台时，visibilitychange/focus 都不会触发，
     每日同步就永远等不到机会。每 5 分钟做一次纯本地判断，未同步才真正联网。 */
  setInterval(function () { if (S.user) syncCorosDaily(); }, 5 * 60 * 1000);
}

async function boot() {
  try { S.lastWriteError = JSON.parse(localStorage.getItem('lb.lastWriteError') || 'null'); } catch (e) {}
  loadPending();
  applyGlass(glassOn(), true);
  initNavScroll();
  initAutoRefresh();
  initGlassLight();
  installManifest();
  installSW();
  applyTheme((function () { try { return localStorage.getItem('lifeboard.theme') || 'dark'; } catch (e) { return 'dark'; } })(), true);

  if (!cloud) {
    showLogin('云服务未能初始化：' + (cloudErr || '未知原因'));
    return;
  }

  const url = new URL(location.href);
  const hasCode = url.searchParams.has('code');
  const hasErr = url.searchParams.has('error');
  const provider = url.searchParams.get('provider');
  const state = url.searchParams.get('state') || '';

  // 1) 登录回调
  if ((hasCode || hasErr) && (provider === 'workbuddy' || provider === 'wechat')) {
    const handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
    if (typeof handler !== 'function') { showLogin('当前 SDK 不支持该登录方式'); return; }
    try {
      const { data: session, error } = await handler.call(cloud.auth);
      if (error) { showLogin(error.message); return; }
      clearAuthParams(url);
      if (session) { await enterApp(session); return; }
    } catch (e) { showLogin((e && e.message) || '登录失败'); return; }
  }

  // 2) 常规会话恢复：本地存储被清过时，先用 cookie 里的 refresh_token 复原
  restoreSession();
  let session = null;
  try {
    const r = await cloud.auth.getSession();
    if (r.error) {
      console.warn('[auth] getSession', r.error.message);
      // 凭证被服务端明确拒绝（refresh_token 失效）时，留着 cookie 只会每次启动都白试一次
      const code = r.error.code || r.error.kind || '';
      if (code === 'invalid_grant' || code === 'unauthenticated') {
        dropCookie(SESSION_COOKIE);
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      }
    }
    session = r.data || null;
  } catch (e) { console.warn('[auth]', e); }

  // 3) COROS 回调（需要已登录）
  if (session && hasCode && state.indexOf('coros_') === 0 && window.Coros) {
    try {
      await Coros.handleCallback(url);
      clearAuthParams(url);
    } catch (e) { toast('COROS 授权失败：' + (e.message || '')); }
  }

  if (session) await enterApp(session);
  // 离线启动：SDK 的会话恢复可能依赖网络请求，失败时用本机快照进入只读模式，
  // 否则 PWA 离线打开只会看到登录页，缓存数据等于没用上。
  else if (navigator.onLine === false && readSnapshot()) {
    await enterApp({ user: { id: 'offline', name: '离线模式', email: '本机缓存数据' } });
  } else showLogin('');
}

function clearAuthParams(url) {
  ['code', 'state', 'provider', 'error', 'error_description', 'iss'].forEach(k => url.searchParams.delete(k));
  history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
}

/* 登录按钮 */
$('#btn-wb-login').addEventListener('click', async function () {
  const btn = this;
  btn.disabled = true;
  try {
    const { data, error } = await cloud.auth.signInWithOAuth({ provider: 'workbuddy', redirectTo: appBase() });
    if (error) throw error;
    location.assign(data.url);
  } catch (e) {
    showLogin((e && e.message) || '无法发起登录，请改用验证码登录');
    btn.disabled = false;
  }
});

let pendingOtp = null;
$('#btn-send-otp').addEventListener('click', async function () {
  const email = ($('#email').value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showLogin('请输入正确的邮箱地址'); return; }
  this.disabled = true;
  try {
    const sent = await cloud.auth.sendOtp({ email: email });
    if (sent.error) throw sent.error;
    pendingOtp = { email: email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
    showLogin('');
    toast('验证码已发送');
    let n = 60;
    const b = this;
    const t = setInterval(() => { n--; b.textContent = n > 0 ? n + 's' : '重新发送'; if (n <= 0) { clearInterval(t); b.disabled = false; } }, 1000);
  } catch (e) {
    showLogin((e && e.message) || '验证码发送失败');
    this.disabled = false;
  }
});

$('#btn-otp-login').addEventListener('click', async function () {
  const email = ($('#email').value || '').trim();
  const code = ($('#otp').value || '').trim();
  if (!pendingOtp || pendingOtp.email !== email) { showLogin('请先获取当前邮箱的验证码'); return; }
  if (!code) { showLogin('请输入验证码'); return; }
  this.disabled = true;
  try {
    const done = await cloud.auth.verifyOtp({
      email: pendingOtp.email,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token: code
    });
    if (done.error) throw done.error;
    pendingOtp = null;
    await enterApp(done.data);
  } catch (e) {
    showLogin((e && e.message) || '登录失败，请检查验证码');
    this.disabled = false;
  }
});

window.addEventListener('scroll', function () {
  const nb = $('#navbar');
  if (nb) nb.classList.toggle('scrolled', window.scrollY > 12);
}, { passive: true });

const backupInput = $('#backup-file');
if (backupInput) backupInput.addEventListener('change', async function () {
  const f = this.files && this.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await restoreBackup(data);
    toast('恢复完成：新增 ' + r.added + ' 条 / 恢复 ' + r.restored + ' 条 / 跳过 ' + r.skipped + ' 条');
    if (S.view === 'me') renderMe();
  } catch (e) {
    toast('导入失败：' + (e.message || '文件格式不对'));
  }
  this.value = '';
});

/* ---------- 键盘 / 触摸 / 快速搜索 ---------- */
document.addEventListener('keydown', function (e) {
  const k = String(e.key || '').toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'k') {
    e.preventDefault(); openQuickSheet();
    setTimeout(function () { const i = $('#quick-q'); if (i) i.focus(); }, 40);
    return;
  }
  /* 确认弹层优先：Esc 取消、Tab 只在两个按钮间循环，不让焦点落到背后的页面 */
  const cm = $('#confirm-mask');
  if (cm && cm.classList.contains('on')) {
    if (k === 'escape') {
      e.preventDefault();
      const c = $('#a-cancel'); if (c) c.click();
      return;
    }
    if (k === 'tab') {
      const f = Array.from(cm.querySelectorAll('.a-btn')).filter(el => el.offsetParent !== null);
      if (f.length) {
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
  }
  if (k === 'escape' && $('#mask').classList.contains('on')) { closeSheet(); return; }
  /* 弹层内 Tab 循环，避免焦点跑到背景内容 */
  if (k === 'tab' && $('#mask') && $('#mask').classList.contains('on')) {
    const f = Array.from(document.querySelectorAll(
      '#sheet button:not([disabled]),#sheet input:not([disabled]),#sheet textarea:not([disabled]),' +
      '#sheet select:not([disabled]),#sheet [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null);
    if (f.length) {
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  /* 所有 data-act 卡片/行都可用 Enter / Space 触发（打卡、日历格、洞察卡等） */
  const t = e.target;
  if ((k === 'enter' || k === ' ') && t && t.getAttribute && t.getAttribute('data-act') &&
      t.matches('.cal-cell,.lrow,[role="button"],[role="checkbox"]')) {
    e.preventDefault(); t.click();
  }
});
document.addEventListener('input', function (e) {
  const id = e.target && e.target.id;
  const DK = { 'ah-name': 'habit', 'ah-target': 'habit', 'mb-title': 'book', 'mb-author': 'book',
    'pl-title': 'plan', 'pl-target': 'plan', 'pl-weeks': 'plan' };
  if (DK[id]) {
    const cur = draftGet(DK[id]) || {};
    cur[id] = e.target.value;
    draftSet(DK[id], cur);
    return;
  }
  if (id !== 'quick-q') return;
  const v = String(e.target.value || '').trim().toLowerCase();
  $$('#quick-list .rowbtn').forEach(b => {
    b.hidden = !!v && String(b.dataset.q || '').toLowerCase().indexOf(v) < 0;
  });
});
let touchStart = null;
document.addEventListener('touchstart', function (e) {
  const t = e.touches && e.touches[0];
  touchStart = (t && e.target.closest && e.target.closest('#cal-box'))
    ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', function (e) {
  if (!touchStart) return;
  const t = e.changedTouches && e.changedTouches[0], st = touchStart;
  touchStart = null;
  if (!t) return;
  const dx = t.clientX - st.x, dy = t.clientY - st.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) swipeMonth(dx < 0 ? 1 : -1);
}, { passive: true });

window.LifeApp = {
  S: S, loadAll: loadAll, render: render, toast: toast, go: go,
  activitiesForDay: activitiesForDay,
  openSheet: openSheet, closeSheet: closeSheet, enterApp: enterApp,
  openBook: openBook, getKv: kvGet, saveKv: kvSet,
  upsertHealth: upsertHealth, upsertActivity: upsertActivity,
  appBase: appBase, iconUrl: iconUrl,
  rateOfDay: rateOfDay, dayEntries: dayEntries, levelOf: levelOf,
  habitsForDay: habitsForDay, activeHabits: activeHabits, corrPairs: corrPairs,
  activeBooks: activeBooks, activeNotes: activeNotes, activePlans: activePlans,
  recentDeleted: recentDeleted, openTrashSheet: openTrashSheet, restoreRow: restoreRow,
  exportBackup: exportBackup, restoreBackup: restoreBackup, fetchBackupRows: fetchBackupRows,
  askConfirm: askConfirm, renderSkeleton: renderSkeleton,
  clearLocalData: clearLocalData, refreshAll: refreshAll, selectPaged: selectPaged,
  patchRow: patchRow, removeHabit: removeHabit, saveHabit: saveHabit, reloadAll: reloadAll,
  syncCorosDaily: syncCorosDaily, corosAutoDoneToday: corosAutoDoneToday,
  snapshotOfOtherUser: function () { return snapMismatch; },
  readSnapshot: readSnapshot, saveSnapshot: saveSnapshot, saveSnapshotSoon: saveSnapshotSoon,
  flushSnapshotNow: flushSnapshotNow, installSW: installSW,
  sportKind: sportKind, sportIcon: sportIcon, baselineOf: baselineOf,
  fieldDelta: fieldDelta, sparkSVG: sparkSVG, cmpHTML: cmpHTML, avgMetric: avgMetric,
  weekReview: weekReview, factorInsights: factorInsights, dataHealth: dataHealth,
  renderFreshness: renderFreshness, swipeMonth: swipeMonth, openQuickSheet: openQuickSheet,
  openCalJumpSheet: openCalJumpSheet, runCorosSync: runCorosSync,
  patchCheckinUI: patchCheckinUI, chartSVG: chartSVG, reviewHTML: reviewHTML,
  persistSession: persistSession, restoreSession: restoreSession,
  applyGlass: applyGlass, toggleGlass: toggleGlass, glassOn: glassOn, initGlassLight: initGlassLight,
  initNavScroll: initNavScroll, syncStickyBars: syncStickyBars, syncStripFade: syncStripFade, autoRefreshToday: autoRefreshToday,
  flushPending: flushPending, findRowId: findRowId, draftGet: draftGet, draftClear: draftClear,
  loadWereadState: loadWereadState, openWereadSyncSheet: openWereadSyncSheet,
  applyShelf: applyShelf, wereadStatusText: wereadStatusText
};

boot();
})();
