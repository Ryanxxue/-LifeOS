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
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const fmt1 = v => (v === null ? '—' : (Math.round(v * 10) / 10).toFixed(1));

/* 主键统一：DB 的 BIGINT 经 JSON 可能是 number 也可能是 string，DOM 的 data-id 恒为 string。
   内存里一律存字符串、比较一律走 eqId；只有写库时才用 dbId 转回数字。 */
const sid = v => (v === null || v === undefined || v === '') ? null : String(v);
const eqId = (a, b) => a != null && b != null && String(a) === String(b);
const dbId = v => { const n = Number(v); return isFinite(n) ? n : v; };

let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
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
function installManifest() {
  const ic = window.__LB_ICONS__ || {};
  // 图标用构建期内联的 data URI：线上 icon-*.png 不带 sharecode 会 403
  const icons = [192, 512].map(function (n) {
    return ic[String(n)] ? {
      src: ic[String(n)], sizes: n + 'x' + n, type: 'image/png', purpose: 'any'
    } : null;
  }).filter(Boolean);
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
  loading: false,
  offline: false,
  snapshotAt: null
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
  run: '<circle cx="15.2" cy="4.8" r="1.7"/><path d="M13 8.2 10 12.4l3 1.9 1.1 4.7"/><path d="M10 12.4 7 13.6l-1.2 4.4"/>',
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
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>'
};
function icon(name, size) {
  const d = P[name] || P.home;
  const s = size || 22;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" class="ic">' + d + '</svg>';
}

/* ==================== 离线快照 / 骨架屏 ==================== */
const SNAP_KEY = 'lb.snapshot.v1';
const SNAP_FIELDS = ['habits', 'checkins', 'health', 'activities', 'books', 'notes', 'plans', 'logs'];
function saveSnapshot() {
  try {
    const data = {};
    SNAP_FIELDS.forEach(function (k) { data[k] = S[k]; });
    const at = new Date().toISOString();
    localStorage.setItem(SNAP_KEY, JSON.stringify({ at: at, data: data }));
    S.snapshotAt = at;
  } catch (e) {}
}
function readSnapshot() {
  try {
    const o = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    return (o && o.data) ? o : null;
  } catch (e) { return null; }
}
function applySnapshot(snap, markOffline) {
  if (!snap || !snap.data) return false;
  SNAP_FIELDS.forEach(function (k) { if (snap.data[k] !== undefined) S[k] = snap.data[k]; });
  S.snapshotAt = snap.at;
  if (markOffline !== false) S.offline = true;
  bump();
  return true;
}
function renderSkeleton() {
  const line = w => '<div class="sk-line sk-anim" style="width:' + w + '"></div>';
  const row = w => '<div class="sk-row"><div class="sk-dot sk-anim"></div>' +
    '<div class="sk-bar sk-anim" style="flex:1;max-width:' + w + '"></div></div>';
  const html = '<div class="sk-wrap">' + line('36%') + line('58%') +
    '<div class="sk-card"><div class="sk-bar sk-anim" style="width:62%;height:18px;margin-bottom:14px"></div>' +
    row('78%') + row('64%') + row('82%') + '</div>' +
    '<div class="sk-card">' + row('70%') + row('86%') + '</div></div>';
  const el = $('#view-today');
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

async function loadAll() {
  if (!DB) throw new Error('云服务未就绪');
  const since = dayKey(addDays(new Date(), -400));
  const [habits, checkins, health, acts, books, notes, plans, logs] = await Promise.all([
    q(DB.from('habits').select('*').order('sort_order').order('id')),
    q(DB.from('checkins').select('habit_id,day').gte('day', since)),
    q(DB.from('health_daily').select('*').gte('day', since).order('day')),
    q(DB.from('activities').select('*').gte('day', since).order('day', { ascending: false }).limit(200)),
    q(DB.from('books').select('*').order('created_at', { ascending: false })),
    q(DB.from('notes').select('*').order('created_at')),
    q(DB.from('study_plans').select('*').order('sort_order').order('id')),
    q(DB.from('study_logs').select('*').gte('day', since).order('day', { ascending: false }))
  ]);
  // habits / plans 保留 archived 记录：计算历史分母需要它们，UI 再用 activeXxx() 过滤
  S.habits = normRows(habits);
  S.checkins = {};
  (checkins || []).forEach(r => {
    const d = String(r.day).slice(0, 10);
    (S.checkins[d] = S.checkins[d] || {})[String(r.habit_id)] = true;
  });
  S.health = {};
  (health || []).forEach(r => { S.health[String(r.day).slice(0, 10)] = r; });
  S.activities = normRows(acts);
  S.books = normRows(books);
  S.notes = normRows(notes);
  S.plans = normRows(plans);
  S.logs = normRows(logs);
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

async function toggleCheckin(habitId, day) {
  const on = isDone(habitId, day);
  const m = S.checkins[day] = S.checkins[day] || {};
  if (on) delete m[String(habitId)]; else m[String(habitId)] = true;
  render();
  try {
    if (on) {
      await q(DB.from('checkins').delete().eq('habit_id', dbId(habitId)).eq('day', day).select());
    } else {
      await q(DB.from('checkins').insert({ habit_id: dbId(habitId), day: day }).select());
    }
  } catch (e) {
    // 回滚
    if (on) m[String(habitId)] = true; else delete m[String(habitId)];
    render();
    toast('保存失败：' + (e.message || '网络异常'));
  }
}

async function saveHabit(payload, id) {
  if (id != null && id !== '') {
    const rows = normRows(await q(DB.from('habits').update(payload).eq('id', dbId(id)).select()));
    if (!rows.length) throw new Error('未能更新该打卡项');
    const i = S.habits.findIndex(h => eqId(h.id, id));
    if (i >= 0) S.habits[i] = Object.assign(S.habits[i], rows[0]);
  } else {
    const rows = normRows(await q(DB.from('habits').insert(payload).select()));
    if (!rows.length) throw new Error('未能创建打卡项');
    S.habits.push(rows[0]);
  }
  render();
}

/* 软删除：保留习惯与其历史打卡，历史完成率才不会因删项而被改写 */
async function removeHabit(id) {
  const at = new Date().toISOString();
  const rows = normRows(await q(DB.from('habits').update({ archived: true, archived_at: at }).eq('id', dbId(id)).select()));
  const h = S.habits.find(x => eqId(x.id, id));
  if (h) { h.archived = true; h.archived_at = at; }
  else if (rows[0]) S.habits.push(rows[0]);
  render();
}

async function saveBook(payload) {
  const rows = normRows(await q(DB.from('books').insert(payload).select()));
  if (!rows.length) throw new Error('未能添加书籍');
  S.books.unshift(rows[0]);
  render();
  return rows[0];
}
/* 软删除：书籍与它的划线共用一个时间戳，恢复时能精确还原这一批 */
async function removeBook(id) {
  const at = new Date().toISOString();
  await q(DB.from('books').update({ deleted_at: at }).eq('id', dbId(id)).select());
  // 只按 id 逐条更新：避免依赖 SDK 对 eq(col, null) / is() 的支持差异
  const noteIds = S.notes.filter(n => eqId(n.book_id, id) && !n.deleted_at).map(n => n.id);
  for (const nid of noteIds) await q(DB.from('notes').update({ deleted_at: at }).eq('id', dbId(nid)).select());
  const b = S.books.find(x => eqId(x.id, id));
  if (b) b.deleted_at = at;
  S.notes.forEach(n => { if (eqId(n.book_id, id) && !n.deleted_at) n.deleted_at = at; });
  render();
}
async function patchBook(id, payload) {
  const rows = normRows(await q(DB.from('books').update(payload).eq('id', dbId(id)).select()));
  if (!rows.length) throw new Error('未能更新书籍');
  const i = S.books.findIndex(b => eqId(b.id, id));
  if (i >= 0) Object.assign(S.books[i], rows[0]);
  render();
}

/* 逐条写入：DB 侧 (owner_id, book_id, md5(content)) 唯一索引兜底，
   同一次粘贴里的重复、以及重复导入都会被跳过而不是静默造重复数据。 */
async function addNotes(list) {
  let added = 0, skipped = 0;
  for (const row of list) {
    if (S.notes.some(n => !n.deleted_at && eqId(n.book_id, row.book_id) && n.content === row.content)) { skipped++; continue; }
    try {
      const rows = normRows(await q(DB.from('notes').insert(row).select()));
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
  await q(DB.from('notes').update({ deleted_at: at }).eq('id', dbId(id)).select());
  const n = S.notes.find(x => eqId(x.id, id));
  if (n) n.deleted_at = at;
  render();
}

async function savePlan(payload) {
  const rows = normRows(await q(DB.from('study_plans').insert(payload).select()));
  if (!rows.length) throw new Error('未能创建计划');
  S.plans.push(rows[0]); render();
}
async function removePlan(id) {
  const at = new Date().toISOString();
  await q(DB.from('study_plans').update({ deleted_at: at }).eq('id', dbId(id)).select());
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
    rows = normRows(await q(DB.from('study_logs').insert({ plan_id: dbId(planId), day: today }).select()));
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

async function upsertHealth(day, patch) {
  const clean = {};
  Object.keys(patch || {}).forEach(k => { if (patch[k] !== null && patch[k] !== undefined) clean[k] = patch[k]; });
  if (!Object.keys(clean).length) return;
  const rows = await q(DB.from('health_daily').select('id').eq('day', day).limit(1));
  if (rows && rows[0]) {
    await q(DB.from('health_daily').update(Object.assign(clean, { updated_at: new Date().toISOString() })).eq('id', rows[0].id).select());
  } else {
    await q(DB.from('health_daily').insert(Object.assign({ day: day }, clean)).select());
  }
  S.health[day] = Object.assign(S.health[day] || { day: day }, clean);
}

async function upsertActivity(row) {
  if (!row || !row.external_id) return;
  const rows = await q(DB.from('activities').select('id').eq('external_id', row.external_id).limit(1));
  if (rows && rows[0]) {
    await q(DB.from('activities').update(row).eq('id', rows[0].id).select());
  } else {
    await q(DB.from('activities').insert(row).select());
    S.activities.push(row);
  }
}

async function kvGet(k) {
  const rows = await q(DB.from('app_kv').select('*').eq('k', k).limit(1));
  return rows && rows[0] ? rows[0].v : null;
}
async function kvSet(k, v) {
  const rows = await q(DB.from('app_kv').select('id').eq('k', k).limit(1));
  if (rows && rows[0]) {
    await q(DB.from('app_kv').update({ v: v, updated_at: new Date().toISOString() }).eq('id', rows[0].id).select());
  } else {
    await q(DB.from('app_kv').insert({ k: k, v: v }).select());
  }
}
async function kvDel(k) {
  await q(DB.from('app_kv').delete().eq('k', k).select());
}

/* ==================== 最近删除与恢复 ==================== */
async function restoreRow(kind, id) {
  if (kind === 'habit') {
    await q(DB.from('habits').update({ archived: false, archived_at: null }).eq('id', dbId(id)).select());
    const h = S.habits.find(x => eqId(x.id, id));
    if (h) { h.archived = false; h.archived_at = null; }
  } else if (kind === 'book') {
    const b = S.books.find(x => eqId(x.id, id));
    const stamp = b ? b.deleted_at : null;
    await q(DB.from('books').update({ deleted_at: null }).eq('id', dbId(id)).select());
    if (b) {
      b.deleted_at = null;
      const ids = S.notes.filter(n => eqId(n.book_id, id) && stamp && n.deleted_at === stamp).map(n => n.id);
      for (const nid of ids) await q(DB.from('notes').update({ deleted_at: null }).eq('id', dbId(nid)).select());
      S.notes.forEach(n => { if (eqId(n.book_id, id) && stamp && n.deleted_at === stamp) n.deleted_at = null; });
    }
  } else if (kind === 'note' || kind === 'plan') {
    const t = kind === 'note' ? 'notes' : 'study_plans';
    await q(DB.from(t).update({ deleted_at: null }).eq('id', dbId(id)).select());
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
async function fetchBackupRows() {
  if (S.offline) {
    const ck = [];
    Object.keys(S.checkins).forEach(function (d) {
      Object.keys(S.checkins[d]).forEach(function (h) { ck.push({ habit_id: h, day: d }); });
    });
    return {
      habits: S.habits, checkins: ck,
      health_daily: Object.keys(S.health).map(d => Object.assign({ day: d }, S.health[d])),
      activities: S.activities, books: S.books, notes: S.notes,
      study_plans: S.plans, study_logs: S.logs, app_kv: []
    };
  }
  const out = {};
  for (const t of BACKUP_TABLES) {
    const rows = normRows(await q(DB.from(t).select('*')));
    // COROS 令牌属于凭据，不写进备份文件
    out[t] = t === 'app_kv' ? rows.filter(r => !/^coros/i.test(String(r.k))) : rows;
  }
  return out;
}
async function exportBackup() {
  const tables = await fetchBackupRows();
  const payload = { app: 'life-dashboard', version: 1, exported_at: new Date().toISOString(), tables: tables };
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
  toast('已导出备份（不含 COROS 授权令牌）');
  return { name: name, json: json, tables: tables };
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
          (/^coros/i.test(String(row.k)) || cur.some(r => String(r.k) === String(row.k)))) { skipped++; continue; }
      try {
        const ins = normRows(await q(DB.from(t).insert(row).select()));
        if (ins[0]) { idMap[t][oldId] = dbId(ins[0].id); cur.push(ins[0]); added++; }
        else skipped++;
      } catch (e) { skipped++; }
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

/* ==================== 通用片段 ==================== */
const TABS = [
  { k: 'today', n: '今日', i: 'home' },
  { k: 'calendar', n: '日历', i: 'calendar' },
  { k: 'reading', n: '阅读', i: 'book' },
  { k: 'study', n: '学习', i: 'pen' },
  { k: 'trend', n: '趋势', i: 'chart' }
];
const VIEWS = ['today', 'calendar', 'reading', 'study', 'trend', 'me'];
const TITLES = { today: '今日', calendar: '日历', reading: '阅读', study: '学习', trend: '趋势', me: '我的' };

function renderChrome() {
  $('#tabbar').innerHTML = TABS.map(t =>
    '<button class="tab' + (S.view === t.k ? ' on' : '') + '" data-act="tab" data-id="' + t.k + '">' +
    icon(t.i, 21) + '<span>' + t.n + '</span></button>').join('');
  // 桌面侧栏保留「我的」入口；移动端走右上角头像按钮
  $('#snav').innerHTML = TABS.map(t =>
    '<button class="' + (S.view === t.k ? 'on' : '') + '" data-act="tab" data-id="' + t.k + '">' +
    icon(t.i, 18) + '<span>' + t.n + '</span></button>').join('') +
    '<div class="side-sep"></div>' +
    '<button class="' + (S.view === 'me' ? 'on' : '') + '" data-act="tab" data-id="me">' +
    icon('person', 18) + '<span>我的</span></button>';
  $('#nav-title').textContent = TITLES[S.view] || '';
  const bm = $('#btn-me');
  if (bm) bm.classList.toggle('on', S.view === 'me');
  const ob = $('#offline-bar');
  if (ob) ob.hidden = !S.offline;
}

function ringHTML(pct, done, total) {
  const r = 32, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, pct)));
  const col = pct >= 1 ? 'var(--green)' : 'var(--blue)';
  return '<div class="ring"><svg width="78" height="78" viewBox="0 0 78 78">' +
    '<circle cx="39" cy="39" r="' + r + '" fill="none" stroke="var(--fill)" stroke-width="7"/>' +
    '<circle cx="39" cy="39" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="7" stroke-linecap="round" ' +
    'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" style="transition:stroke-dashoffset .35s"/>' +
    '</svg><div class="val"><b>' + done + '</b><i>/ ' + total + '</i></div></div>';
}

/* ==================== 今日 ==================== */
function heroWords(pct) {
  if (pct >= 1) return ['全部完成', '今天可以安心收工。'];
  if (pct >= 0.7) return ['只剩几项', '保持这个节奏。'];
  if (pct >= 0.4) return ['过半了', '节奏已经起来了。'];
  if (pct > 0) return ['已启动', '先完成一项，就有一项。'];
  return ['今天还没开始', '点一下任意一项即可开始。'];
}

function healthCells(day) {
  const h = S.health[day] || {};
  const cells = [
    { k: '睡眠', v: fmt1(num(h.sleep_total)), u: 'h' },
    { k: 'HRV', v: h.hrv == null ? '—' : Math.round(h.hrv), u: 'ms' },
    { k: '静息心率', v: h.resting_hr == null ? '—' : Math.round(h.resting_hr), u: 'bpm' },
    { k: '训练负荷', v: h.training_load == null ? '—' : Math.round(h.training_load), u: '' }
  ];
  return '<div class="health">' + cells.map(c =>
    '<div class="hcell' + (c.v === '—' ? ' empty' : '') + '">' +
    '<div class="k">' + c.k + '</div>' +
    '<div class="v">' + c.v + (c.u && c.v !== '—' ? '<span class="u">' + c.u + '</span>' : '') + '</div></div>'
  ).join('') + '</div>';
}

function habitRow(h, day, editing, actName) {
  const on = isDone(h.id, day);
  return '<div class="lrow' + (on ? ' done' : '') + '" data-act="' + actName + '" data-id="' + h.id + '" data-day="' + day + '">' +
    '<div class="licon" style="background:' + esc(h.color) + '">' + icon(h.icon || 'circle', 17) + '</div>' +
    '<div class="lbody"><div class="lrow-t">' + esc(h.name) + '</div>' +
    '<div class="lrow-sub">' + esc(h.target || '每天') + '</div></div>' +
    (editing ? '<div class="minus" data-act="delhabit" data-id="' + h.id + '">' + icon('minus', 15) + '</div>'
             : '<div class="chk' + (on ? ' on' : '') + '">' + (on ? icon('check', 15) : '') + '</div>') +
    '</div>';
}

function renderToday() {
  const day = TODAY();
  const total = dayEntries(day);
  const done = doneCount(day);
  const pct = total ? done / total : 0;
  const w = heroWords(pct);
  const d = parseDay(day);
  const reading = activeBooks().filter(b => b.status === 'reading').slice(0, 6);
  const h = S.health[day];

  let html = '<div class="head"><div class="date">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WK[d.getDay()] + '</div>' +
    '<h2>今日</h2></div>';

  html += '<div class="hero">' + ringHTML(pct, done, total) +
    '<div class="hero-txt"><div class="t">' + w[0] + '</div><div class="s">' + w[1] + '</div></div></div>';

  html += healthCells(day);
  if (!h) {
    html += '<div class="gfoot" style="display:flex;align-items:center;justify-content:space-between">' +
      '<span>身体数据未同步</span>' +
      '<button class="pill" data-act="corosSync" style="font-size:12px;padding:4px 10px">立即同步</button></div>';
  }

  html += '<div class="gtitle" style="display:flex;justify-content:space-between;align-items:center">' +
    '<span>今日打卡</span>' +
    (total ? '<button style="color:var(--blue);font-size:13.5px" data-act="edittoggle">' + (S.editing ? '完成' : '编辑') + '</button>' : '') +
    '</div>';

  if (!total) {
    html += '<div class="card"><div class="empty">还没有打卡项。<br>先在下方新建一个，或到「我的 → 打卡项管理」添加。</div>' +
      '<div class="addrow" data-act="newhabit">' + icon('plus', 17) + '新建打卡项</div></div>';
  } else {
    html += '<div class="card">' + habitsForDay(day).map(x => habitRow(x, day, S.editing, 'toggle')).join('') +
      (S.editing ? '' : '<div class="addrow" data-act="newhabit">' + icon('plus', 17) + '新建打卡项</div>') + '</div>';
  }

  if (reading.length) {
    html += '<div class="gtitle" style="display:flex;justify-content:space-between;align-items:center">' +
      '<span>在读</span><button style="color:var(--blue);font-size:13.5px" data-act="tab" data-id="reading">全部</button></div>';
    html += '<div class="card"><div class="rail">' + reading.map(b =>
      '<div class="bk" data-act="openbook" data-id="' + b.id + '">' + bookCover(b) +
      '<div class="bk-t">' + esc(b.title) + '</div><div class="bk-a">' + esc(b.author || '') + '</div></div>').join('') +
      '</div></div>';
  }

  if (S.activities.length) {
    const a = S.activities[0];
    const dstr = String(a.day).slice(0, 10);
    html += '<div class="gtitle">最近运动</div><div class="card">' +
      '<div class="lrow" style="cursor:default">' +
      '<div class="licon" style="background:var(--green)">' + icon('run', 17) + '</div>' +
      '<div class="lbody"><div class="lrow-t">' + esc(a.name || a.type || '运动') + '</div>' +
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
function bookCover(b, big) {
  const c = coverOf(b);
  return '<div class="bk-cover' + (big ? ' lg' : '') + '" style="background-image:' +
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

function renderCalendar() {
  const m = S.calMonth;
  const y = m.getFullYear(), mo = m.getMonth();
  const first = new Date(y, mo, 1);
  const start = addDays(first, -first.getDay());
  const rows = Math.ceil((first.getDay() + new Date(y, mo + 1, 0).getDate()) / 7);

  let cells = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(start, i);
    const k = dayKey(d);
    const out = d.getMonth() !== mo;
    const lv = levelOf(k);
    const cls = ['cal-cell'];
    if (out) cls.push('out');
    if (lv) cls.push('l' + lv);
    if (k === TODAY()) cls.push('today');
    if (k === S.selDay) cls.push('sel');
    cells += '<div class="' + cls.join(' ') + '" data-act="calday" data-id="' + k + '">' + d.getDate() + '</div>';
  }

  const monthDays = [];
  for (let d = 1; d <= new Date(y, mo + 1, 0).getDate(); d++) monthDays.push(dayKey(new Date(y, mo, d)));
  const fullDays = monthDays.filter(k => levelOf(k) === 4).length;
  const anyDays = monthDays.filter(k => levelOf(k) > 0).length;

  let html = '<div class="head"><div class="date">完成 ' + fullDays + ' 天 · 有记录 ' + anyDays + ' 天</div><h2>日历</h2></div>';

  html += '<div class="cal"><div class="cal-top"><div class="m">' + y + ' 年 ' + (mo + 1) + ' 月</div>' +
    '<div class="cal-nav"><button data-act="calprev">' + icon('left', 17) + '</button>' +
    '<button data-act="calnext">' + icon('chev', 17) + '</button></div></div>' +
    '<div class="wk">' + WK.map(w => '<div>' + w + '</div>').join('') + '</div>' +
    '<div class="grid">' + cells + '</div>' +
    '<div class="legend"><span>少</span><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i>' +
    '<i style="background:var(--heat-3)"></i><i style="background:var(--blue)"></i><span>多</span></div></div>';

  const sd = parseDay(S.selDay);
  const dn = doneCount(S.selDay);
  html += '<div class="gtitle">' + (sd.getMonth() + 1) + '月' + sd.getDate() + '日 周' + WK[sd.getDay()] +
    ' · 完成 ' + dn + '/' + dayEntries(S.selDay) + '</div>';
  if (!dayEntries(S.selDay)) {
    html += '<div class="card"><div class="empty">这一天还没有打卡项</div></div>';
  } else {
    html += '<div class="card">' + habitsForDay(S.selDay).map(h =>
      '<div class="lrow' + (isDone(h.id, S.selDay) ? ' done' : '') + '" data-act="daytoggle" data-id="' + h.id + '" data-day="' + S.selDay + '">' +
      '<div class="licon" style="background:' + esc(h.color) + '">' + icon(h.icon || 'circle', 17) + '</div>' +
      '<div class="lbody"><div class="lrow-t">' + esc(h.name) + '</div>' +
      '<div class="lrow-sub">' + esc(h.target || '每天') + '</div></div>' +
      '<div class="chk' + (isDone(h.id, S.selDay) ? ' on' : '') + '">' + (isDone(h.id, S.selDay) ? icon('check', 15) : '') + '</div>' +
      '</div>').join('') + '</div>';
    html += '<div class="gfoot">点任意一项可补录或取消该天的记录。</div>';
  }
  $('#view-calendar').innerHTML = html;
}

/* ==================== 阅读 ==================== */
function bookNotes(bookId) { return S.notes.filter(n => eqId(n.book_id, bookId) && !n.deleted_at); }

function renderReading() {
  const f = S.filter;
  const books = activeBooks();
  const list = books.filter(b => f === 'all' ? true : b.status === f);
  const reading = books.filter(b => b.status === 'reading');

  let html = '<div class="head"><div class="date">共 ' + books.length + ' 本 · ' +
    activeNotes().length + ' 条划线</div><h2>阅读</h2></div>';

  html += '<div class="seg">' +
    [['all', '全部'], ['reading', '在读'], ['done', '读完']].map(x =>
      '<button class="' + (f === x[0] ? 'on' : '') + '" data-act="filter" data-id="' + x[0] + '">' + x[1] + '</button>').join('') +
    '</div>';

  if (reading.length && f !== 'done') {
    html += '<div class="gtitle">正在阅读</div><div class="card"><div class="rail">' + reading.map(b => {
      const n = bookNotes(b.id).length;
      return '<div class="bk" data-act="openbook" data-id="' + b.id + '">' + bookCover(b) +
        '<div class="bk-t">' + esc(b.title) + '</div><div class="bk-a">' + (n ? n + ' 条划线' : esc(b.author || '')) + '</div></div>';
    }).join('') + '</div></div>';
  }

  html += '<div class="gtitle" style="display:flex;justify-content:space-between;align-items:center">' +
    '<span>书架</span><button style="color:var(--blue);font-size:13.5px" data-act="addbook">添加</button></div>';

  if (!list.length) {
    html += '<div class="card"><div class="empty">书架还是空的。<br>可以从微信读书粘贴导入，也可以手动添加。</div>' +
      '<div class="addrow" data-act="addbook">' + icon('plus', 17) + '添加书籍</div></div>';
  } else {
    html += '<div class="shelf">' + list.map(b =>
      '<div class="bk" data-act="openbook" data-id="' + b.id + '">' + bookCover(b) +
      '<div class="bk-t">' + esc(b.title) + '</div><div class="bk-a">' + esc(b.author || '') + '</div></div>').join('') + '</div>';
  }

  $('#view-reading').innerHTML = html;
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
    '<div style="font-size:18px;font-weight:500;line-height:1.3">' + esc(b.title) + '</div>' +
    '<div style="font-size:13px;color:var(--text-2);margin-top:4px">' + esc(b.author || '未填作者') + '</div>' +
    '<div style="font-size:12.5px;color:var(--text-3);margin-top:8px">' + (b.status === 'done' ? '已读完' : '在读') +
    ' · ' + notes.length + ' 条划线</div>' +
    '<div class="bar" style="margin:10px 0 0"><i style="width:' + Math.max(0, Math.min(100, b.progress || 0)) + '%"></i></div>' +
    '</div></div>' +
    '<div class="gtitle" style="margin-top:0">划线 · ' + notes.length + '</div>' +
    (notes.length ? notes.map(n =>
      '<div class="note"><div class="ch">' + esc(n.chapter || '') + '</div>' +
      '<div class="tx">' + esc(n.content) + '</div>' +
      '<button class="x" data-act="delnote" data-id="' + n.id + '">' + icon('x', 13) + '</button></div>').join('')
      : '<div class="empty" style="padding:20px 0">还没有划线</div>') +
    '<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">' +
    '<button class="btnblock gray" data-act="togglebookstatus" data-id="' + b.id + '">' +
    (b.status === 'done' ? '标记为在读' : '标记为读完') + '</button>' +
    '<button class="btnblock red" data-act="delbook" data-id="' + b.id + '">删除这本书</button>' +
    '</div></div>';
  openSheet(html);
}

/* ==================== 学习 ==================== */
function weekStart(d) { const x = new Date(d); return addDays(x, -x.getDay()); }
function logsThisWeek(planId) {
  const ws = dayKey(weekStart(new Date()));
  return S.logs.filter(l => eqId(l.plan_id, planId) && String(l.day).slice(0, 10) >= ws);
}

function renderStudy() {
  const plans = activePlans();
  let html = '<div class="head"><div class="date">' + plans.length + ' 个计划 · 本周 ' +
    S.logs.filter(l => String(l.day).slice(0, 10) >= dayKey(weekStart(new Date()))).length + ' 次记录</div><h2>学习</h2></div>';

  if (!plans.length) {
    html += '<div class="card"><div class="empty">还没有学习计划。<br>建一个，比如「每周读 3 次专业书」。</div>' +
      '<div class="addrow" data-act="newplan">' + icon('plus', 17) + '新建计划</div></div>';
  } else {
    plans.forEach(p => {
      const n = logsThisWeek(p.id).length;
      const target = p.target_per_week || 3;
      const pct = Math.min(100, Math.round(n / target * 100));
      html += '<div class="plan"><div class="plan-top"><div>' +
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
    html += '<div class="card" style="margin-top:4px"><div class="addrow" data-act="newplan">' + icon('plus', 17) + '新建计划</div></div>';
  }

  const recent = S.logs.slice(0, 8);
  if (recent.length) {
    html += '<div class="gtitle">最近记录</div><div class="card">' + recent.map(l => {
      const p = S.plans.find(x => eqId(x.id, l.plan_id));
      const d = String(l.day).slice(0, 10);
      const dd = parseDay(d);
      return '<div class="lrow" style="cursor:default">' +
        '<div class="licon" style="background:var(--blue)">' + icon('pen', 16) + '</div>' +
        '<div class="lbody"><div class="lrow-t">' + esc(p ? p.title : '已删除的计划') + '</div>' +
        '<div class="lrow-sub">' + (dd.getMonth() + 1) + '月' + dd.getDate() + '日</div></div></div>';
    }).join('') + '</div>';
  }
  $('#view-study').innerHTML = html;
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
function corrPairs(days) {
  const xs = [], ys = [];
  days.forEach(d => {
    const h = S.health[d];
    if (!h || h.sleep_total == null) return;
    const sleep = Number(h.sleep_total);
    if (!isFinite(sleep) || sleep <= 0 || sleep > 16) return;
    const next = dayKey(addDays(parseDay(d), 1));
    const rate = rateOfDay(next);
    if (rate === null || !hasCheckins(next)) return;
    xs.push(sleep); ys.push(rate);
  });
  return { xs: xs, ys: ys, n: xs.length };
}

function chartSVG(days, lines) {
  const W = 320, H = 132, PL = 8, PR = 8, PT = 10, PB = 18;
  const iw = W - PL - PR, ih = H - PT - PB;
  const n = days.length;
  const xAt = i => PL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  let out = '<svg class="chartwrap" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" style="height:auto">';
  for (let g = 0; g <= 3; g++) {
    const y = PT + (ih / 3) * g;
    out += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) +
      '" stroke="var(--sep)" stroke-width=".6" stroke-dasharray="2 3"/>';
  }
  lines.forEach(L => {
    const vals = days.map(d => L.get(d));
    const vmax = L.max || 1, vmin = L.min || 0;
    let path = '', started = false;
    vals.forEach((v, i) => {
      if (v === null) { started = false; return; }
      const y = PT + ih - ((Math.max(vmin, Math.min(vmax, v)) - vmin) / (vmax - vmin || 1)) * ih;
      const x = xAt(i);
      path += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      started = true;
    });
    if (path) out += '<path d="' + path.trim() + '" fill="none" style="stroke:' + L.color + '" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
  });
  const first = parseDay(days[0]), last = parseDay(days[n - 1]);
  out += '<text x="' + PL + '" y="' + (H - 4) + '" font-size="9" fill="var(--text-3)">' +
    (first.getMonth() + 1) + '/' + first.getDate() + '</text>';
  out += '<text x="' + (W - PR) + '" y="' + (H - 4) + '" font-size="9" fill="var(--text-3)" text-anchor="end">' +
    (last.getMonth() + 1) + '/' + last.getDate() + '</text>';
  out += '</svg>';
  return out;
}

function renderTrend() {
  const days = seriesDays(S.range);
  const rates = days.map(rateOfDay).filter(v => v !== null);
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

  const hs = days.map(d => S.health[d]).filter(x => x && x.sleep_total != null);
  const avgSleep = hs.length ? hs.reduce((a, b) => a + Number(b.sleep_total), 0) / hs.length : null;
  const hrvs = days.map(d => S.health[d]).filter(x => x && x.hrv != null);
  const avgHrv = hrvs.length ? hrvs.reduce((a, b) => a + Number(b.hrv), 0) / hrvs.length : null;

  const pairs = corrPairs(days);
  const r = pairs.n >= 3 ? pearson(pairs.xs, pairs.ys) : null;
  const p = (r === null ? null : pValue(r, pairs.n));

  let html = '<div class="head"><div class="date">近 ' + S.range + ' 天</div><h2>趋势</h2></div>';

  html += '<div class="seg">' + [30, 60, 90].map(n =>
    '<button class="' + (S.range === n ? 'on' : '') + '" data-act="range" data-id="' + n + '">' + n + ' 天</button>').join('') + '</div>';

  html += '<div class="metric">' +
    '<div class="mcell"><div class="k">打卡完成率</div><div class="v">' + (avgRate === null ? '—' : Math.round(avgRate * 100) + '<span style="font-size:15px">%</span>') + '</div>' +
    '<div class="d">' + rates.length + ' 天有有效打卡项</div></div>' +
    '<div class="mcell"><div class="k">平均睡眠</div><div class="v">' + (avgSleep === null ? '—' : fmt1(avgSleep)) + (avgSleep === null ? '' : '<span style="font-size:15px">h</span>') + '</div>' +
    '<div class="d">' + hs.length + ' 天有数据</div></div>' +
    '<div class="mcell wide"><div class="k">平均 HRV</div><div class="v">' + (avgHrv === null ? '—' : Math.round(avgHrv)) + (avgHrv === null ? '' : '<span style="font-size:15px">ms</span>') + '</div>' +
    '<div class="d">' + hrvs.length + ' 天有数据</div></div>' +
    '</div>';

  html += '<div class="chartcard"><div class="chart-head"><div class="t">完成率与睡眠</div>' +
    '<div class="lg"><span><i style="background:var(--blue)"></i>完成率</span><span><i style="background:var(--orange)"></i>睡眠(h)</span></div></div>' +
    chartSVG(days, [
      { get: d => rateOfDay(d), min: 0, max: 1, color: 'var(--blue)' },
      { get: d => { const h = S.health[d]; return h && h.sleep_total != null ? Number(h.sleep_total) : null; }, min: 0, max: 10, color: 'var(--orange)' }
    ]) + '</div><div class="gfoot" style="margin-left:6px">完成率按当日有效打卡项计算（0–100%），睡眠按 0–10 小时，各自缩放；断口表示当天没有数据。</div>';

  const rhrs = days.map(d => S.health[d]).filter(x => x && x.resting_hr != null);
  const pool = hrvs.map(x => Number(x.hrv)).concat(rhrs.map(x => Number(x.resting_hr)));
  let lo = pool.length ? Math.min.apply(null, pool) : 40;
  let hi = pool.length ? Math.max.apply(null, pool) : 100;
  const padV = Math.max(3, (hi - lo) * 0.18);
  lo = Math.floor(lo - padV); hi = Math.ceil(hi + padV);

  html += '<div class="chartcard"><div class="chart-head"><div class="t">HRV 与静息心率</div>' +
    '<div class="lg"><span><i style="background:var(--green)"></i>HRV</span><span><i style="background:var(--pink)"></i>心率</span></div></div>' +
    chartSVG(days, [
      { get: d => { const h = S.health[d]; return h && h.hrv != null ? Number(h.hrv) : null; }, min: lo, max: hi, color: 'var(--green)' },
      { get: d => { const h = S.health[d]; return h && h.resting_hr != null ? Number(h.resting_hr) : null; }, min: lo, max: hi, color: 'var(--pink)' }
    ]) + '</div><div class="gfoot" style="margin-left:6px">两条线共用同一纵轴范围（' + lo + '–' + hi + '），断口表示当天没有数据。</div>';

  let corr;
  if (r === null) {
    corr = '<div style="font-size:13.5px;color:var(--text-2);line-height:1.6">样本不足。需要至少 3 天「当晚有睡眠数据 + 次日有打卡动作」才能计算，当前只有 ' + pairs.n + ' 天。</div>';
  } else {
    let verdict;
    if (pairs.n < 8) {
      verdict = '样本偏少（n=' + pairs.n + '），这个数值仅供参考，暂不下结论。继续积累到 8 天以上再看。';
    } else if (p !== null && p < 0.05) {
      verdict = '在 0.05 水平上显著' + (r > 0 ? '正相关：睡得更久的当晚之后，次日打卡完成率往往更高。'
                                             : '负相关：睡得更久的当晚之后，次日打卡完成率反而偏低。') +
        '但这只是统计关联，不代表因果。';
    } else {
      verdict = '未达到统计显著（p=' + (p === null ? '—' : p.toFixed(2)) + ' ≥ 0.05），不能据此认为睡眠长短与次日完成率有关系。';
    }
    corr = '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">' +
      '<div style="font-size:26px;font-weight:500;letter-spacing:-.02em">' + (r >= 0 ? '+' : '') + r.toFixed(2) + '</div>' +
      '<div style="font-size:13px;color:var(--text-2)">相关系数 r · n=' + pairs.n + ' · p=' +
      (p === null ? '—' : p.toFixed(3)) + '</div></div>' +
      '<div style="font-size:13px;color:var(--text-2);line-height:1.65;margin-top:8px">' + verdict + '</div>';
  }
  html += '<div class="gtitle">睡眠与次日完成率的关系</div><div class="card" style="padding:16px">' + corr +
    '</div><div class="gfoot">口径：睡眠取当晚，完成率取次日；仅纳入有睡眠数据且次日有有效打卡项、有打卡动作的日子。相关不等于因果。</div>';

  $('#view-trend').innerHTML = html;
}

/* ==================== 我的 ==================== */
function renderMe() {
  const u = S.user || {};
  const initial = (u.name || u.email || '·').slice(0, 1).toUpperCase();
  const coros = window.Coros ? Coros.status() : { connected: false };
  const sync = S.health[TODAY()];

  let html = '<div class="head"><div class="date">账户与连接</div><h2>我的</h2></div>';

  html += '<div class="card"><div class="profile"><div class="avatar">' +
    (u.avatarUrl ? '<img src="' + esc(u.avatarUrl) + '" alt="">' : esc(initial)) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="n">' + esc(u.name || '已登录') + '</div>' +
    '<div class="e">' + esc(u.email || u.phone || u.id || '') + '</div></div></div>' +
    '<button class="rowbtn" data-act="copylink"><div class="icbox" style="background:var(--fill-2);color:var(--text)">' + icon('link', 16) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">复制访问链接</div>' +
    '<div class="rb-s">在另一台设备打开即可登录同一账号</div></div>' +
    '<div class="chev">' + icon('chev', 15) + '</div></button></div>';

  html += '<div class="gtitle">数据连接</div><div class="card">' +
    '<button class="rowbtn" data-act="corosConnect">' +
    '<div class="icbox" style="background:var(--orange)">' + icon('run', 17) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">COROS</div>' +
    '<div class="rb-s">' + (coros.connected ? ('已连接 · ' + (coros.lastSync ? '上次同步 ' + coros.lastSync : '尚未同步')) : '未连接，点此授权') + '</div></div>' +
    '<div class="dot' + (coros.connected ? '' : ' off') + '"></div></button>' +

    '<button class="rowbtn" data-act="import">' +
    '<div class="icbox" style="background:var(--teal)">' + icon('bookop', 17) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="rb-t">微信读书</div>' +
    '<div class="rb-s">粘贴导入划线</div></div>' +
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
    '</div></div>';

  const lastExport = (function () { try { return localStorage.getItem('lb.last_export'); } catch (e) { return null; } })();
  const sinceExport = lastExport ? Math.floor((Date.now() - new Date(lastExport).getTime()) / 86400000) : null;
  html += '<div class="gtitle">数据与备份</div><div class="card">' +
    (sinceExport === null || sinceExport >= 7
      ? '<div class="rowbtn" style="cursor:default"><div style="flex:1;font-size:13px;color:var(--orange)">' +
        (sinceExport === null ? '还没有导出过备份，建议先导出一份' : '距上次导出已 ' + sinceExport + ' 天，建议重新导出') +
        '</div></div>' : '') +
    '<button class="rowbtn" data-act="exportbackup">' +
    '<div class="icbox" style="background:var(--green)">' + icon('up', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">导出备份</div><div class="rb-s">全量 JSON，不含 COROS 授权令牌</div></div>' +
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
      '<button style="color:var(--red);font-size:13.5px;padding:6px 2px" data-act="delhabit" data-id="' + h.id + '">删除</button>' +
      '</div>').join('') : '<div class="empty" style="padding:22px 16px">还没有打卡项</div>') +
    '<div class="addrow" data-act="newhabit">' + icon('plus', 17) + '新建打卡项</div></div>';

  html += '<div style="margin-top:22px"><button class="btnblock gray danger" data-act="logout">退出登录</button></div>';
  html += '<div class="gfoot" style="text-align:center;margin-top:14px">数据存储在你的云端账户，多设备同一账号即可同步。<br>' +
    '构建 ' + esc(window.__LB_BUILD__ || 'dev') + ' · 离线时显示本机最后一次同步的数据</div>';

  $('#view-me').innerHTML = html;
}

/* ==================== 渲染调度 ==================== */
function render() {
  if (!S.user) return;
  renderChrome();
  const map = { today: renderToday, calendar: renderCalendar, reading: renderReading, study: renderStudy, trend: renderTrend, me: renderMe };
  VIEWS.forEach(k => { const el = $('#view-' + k); if (el) el.hidden = (S.view !== k); });
  (map[S.view] || renderToday)();
}

function go(view) {
  S.view = view;
  S.editing = false;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ==================== 弹层 ==================== */
function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#mask').classList.add('on');
}
function closeSheet() {
  $('#mask').classList.remove('on');
  setTimeout(() => { if (!$('#mask').classList.contains('on')) $('#sheet').innerHTML = ''; }, 300);
}

/* iOS 风格确认弹层，替代原生 confirm()；返回 Promise<boolean> */
function askConfirm(opts) {
  return new Promise(function (resolve) {
    const m = $('#confirm-mask');
    if (!m) { resolve(false); return; }
    $('#a-title').textContent = opts.title || '确认操作';
    $('#a-msg').textContent = opts.message || '';
    const okBtn = $('#a-ok');
    okBtn.textContent = opts.okText || '删除';
    okBtn.className = 'a-btn ' + (opts.danger === false ? 'blue' : 'danger');
    m.classList.add('on');
    function done(v) {
      m.classList.remove('on');
      okBtn.onclick = null; $('#a-cancel').onclick = null; m.onclick = null;
      resolve(v);
    }
    okBtn.onclick = function () { done(true); };
    $('#a-cancel').onclick = function () { done(false); };
    m.onclick = function (e) { if (e.target === m) done(false); };
  });
}
/* 离线时禁止一切写库 / 授权动作，只保留浏览与导出 */
const WRITE_ACTS = new Set(['toggle', 'daytoggle', 'savehabit', 'delhabit', 'savemanualbook',
  'delnote', 'delbook', 'togglebookstatus', 'saveplan', 'logstudy', 'delplan', 'doimport',
  'corosConnect', 'corosSync', 'restore', 'importbackup']);

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
}

async function submitHabit(editId) {
  const name = ($('#ah-name') && $('#ah-name').value || '').trim();
  if (!name) { toast('请填写名称'); return; }
  const target = ($('#ah-target') && $('#ah-target').value || '').trim() || '每天';
  const payload = { name: name, target: target, icon: window.__pickIcon || 'sun', color: window.__pickColor || '#0A84FF' };
  try {
    await saveHabit(payload, editId || null);
    closeSheet();
    toast(editId ? '已保存' : '已添加');
  } catch (e) { toast('保存失败：' + (e.message || '网络异常')); }
}

/* ==================== 添加书籍 ==================== */
function openAddBookSheet() {
  const html = '<div class="grabber"></div>' +
    '<div class="sheet-h"><div class="t">添加书籍</div><button data-act="closesheet">取消</button></div>' +
    '<div class="sheet-body">' +
    '<div class="card">' +
    '<button class="rowbtn" data-act="import"><div class="icbox" style="background:var(--teal)">' + icon('bookop', 17) + '</div>' +
    '<div style="flex:1"><div class="rb-t">从微信读书导入</div><div class="rb-s">粘贴划线内容，自动识别书名与笔记</div></div>' +
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
}

async function submitManualBook() {
  const t = ($('#mb-title') && $('#mb-title').value || '').trim();
  if (!t) { toast('请填写书名'); return; }
  const a = ($('#mb-author') && $('#mb-author').value || '').trim();
  try {
    await saveBook({ title: t, author: a || null, status: 'reading', progress: 0, source: 'manual' });
    closeSheet(); toast('已添加');
  } catch (e) { toast('添加失败：' + (e.message || '网络异常')); }
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
}

async function submitPlan() {
  const t = ($('#pl-title') && $('#pl-title').value || '').trim();
  if (!t) { toast('请填写计划名称'); return; }
  const tg = parseInt(($('#pl-target') && $('#pl-target').value) || '3', 10) || 3;
  const w = parseInt(($('#pl-weeks') && $('#pl-weeks').value) || '0', 10) || null;
  try {
    await savePlan({ title: t, target_per_week: tg, total_weeks: w, sort_order: activePlans().length });
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
    '<div style="text-align:center;margin-top:10px"><button style="color:var(--blue);font-size:13.5px" data-act="demofill">填入一段示例</button></div>' +
    '</div>';
  openSheet(html);
}

async function doImport() {
  const raw = ($('#wr-text') && $('#wr-text').value || '').trim();
  if (!raw) { toast('请先粘贴内容'); return; }
  const parsed = window.Weread ? Weread.parse(raw) : { title: '', author: '', notes: [] };
  if (!parsed.notes.length) { toast('没有解析到划线内容'); return; }
  try {
    let book = parsed.title ? activeBooks().find(b => b.title === parsed.title) : null;
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

  if (S.offline && WRITE_ACTS.has(act)) { toast('离线中，请联网后再操作'); return; }

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
    case 'theme': toggleTheme(); renderMe(); break;

    case 'toggle':
      if (S.editing) break;
      await toggleCheckin(eid, day || TODAY());
      break;
    case 'daytoggle':
      await toggleCheckin(eid, day || S.selDay);
      break;
    case 'edittoggle': S.editing = !S.editing; render(); break;

    case 'calprev': S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); render(); break;
    case 'calnext': S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); render(); break;
    case 'calday': S.selDay = id; render(); break;

    case 'newhabit': openHabitSheet(null); break;
    case 'savehabit': await submitHabit(eid || null); break;
    case 'delhabit': {
      const h = S.habits.find(x => eqId(x.id, eid));
      if (!(await askConfirm({
        title: '删除打卡项',
        message: '删除「' + (h ? h.name : '') + '」？历史打卡记录会保留，用于计算完成率。',
        okText: '删除'
      }))) break;
      try { await removeHabit(eid); toast('已删除'); } catch (e) { toast('删除失败：' + (e.message || '')); }
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
        toast('已删除');
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
      try { await removeBook(eid); closeSheet(); toast('已删除'); }
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
      if (!(await askConfirm({
        title: '删除学习计划', message: '计划会移入「最近删除」，历史记录保留。', okText: '删除'
      }))) break;
      try { await removePlan(eid); toast('已删除'); } catch (e) { toast('删除失败：' + (e.message || '')); }
      break;
    }

    case 'import': openImportSheet(); break;
    case 'doimport': await doImport(); break;
    case 'demofill': {
      const ta = $('#wr-text');
      if (ta) ta.value = '反脆弱 - 塔勒布\n允许自己犯错，是反脆弱的第一步。\n系统的韧性来自冗余，而不是精确。\n我们高估了知识，低估了行动。';
      break;
    }

    case 'corosConnect':
      if (window.Coros) await Coros.connect();
      break;
    case 'corosSync': {
      if (!window.Coros) break;
      const st = Coros.status();
      if (!st.connected) { toast('请先连接 COROS'); break; }
      toast('正在同步…');
      let res;
      try { res = await Coros.sync(); }
      catch (e) {
        toast(e && e.soft ? e.message
          : 'COROS 同步失败：' + ((e && e.message) || '未知错误，请查看同步诊断'));
        break;
      }
      // 同步与刷新是两回事：刷新失败不能误报成同步失败
      try { await loadAll(); render(); }
      catch (e) { toast('同步完成，但刷新数据失败：' + ((e && e.message) || '')); break; }
      const w = (res && res.warnings) || [];
      toast('已同步 ' + ((res && res.days) || 0) + ' 天身体数据、' +
        ((res && res.activities) || 0) + ' 条运动' +
        (w.length ? '，' + w.length + ' 处未识别，请查看同步诊断' : ''));
      break;
    }
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
          '<div style="font-size:13px;color:var(--red);line-height:1.6">' + esc(diag.error) + '</div></div>';
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
          '<div class="tx" style="font-size:11.5px;white-space:pre-wrap;word-break:break-all">' +
          esc(String(x.preview || '')) + '</div></div>').join('');
      }
      if (!w.length && !(diag && diag.log && diag.log.length)) {
        html += '<div class="empty" style="padding:20px 0">上次同步没有未识别字段。</div>';
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
        title: '退出登录', message: '退出后需要重新登录才能同步数据。', okText: '退出登录', danger: false
      }))) break;
      try { await cloud.auth.signOut(); } catch (e) {}
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
  $('#login-view').hidden = true;
  $('#main').hidden = false;
  S.loading = true;
  renderChrome();
  renderSkeleton();                       // 首屏不再是空白
  const snap = readSnapshot();
  if (snap) { applySnapshot(snap, false); render(); }   // 先用本地快照给出可见内容
  if (navigator.onLine === false) {
    S.loading = false;
    if (snap) { applySnapshot(snap); render(); toast('离线模式 · 正在显示本机缓存数据'); return; }
  }
  try {
    await loadAll();
    S.offline = false;
    S.loading = false;
    saveSnapshot();
    render();
    if (window.Coros) Coros.afterLogin();
  } catch (e) {
    S.loading = false;
    S.offline = true;
    console.error('[load] failed', e);
    if (snap && applySnapshot(snap)) {
      render();
      toast('离线模式 · 正在显示本机缓存数据');
    } else {
      renderChrome();
      $('#view-today').innerHTML = '<div class="empty" style="padding-top:80px">数据加载失败<br><span style="font-size:12.5px">' +
        esc(e && e.message || '网络异常') + '</span><br><br><button class="pill" onclick="location.reload()">重试</button></div>';
    }
  }
}

async function boot() {
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

  // 2) 常规会话恢复
  let session = null;
  try {
    const r = await cloud.auth.getSession();
    if (r.error) console.warn('[auth] getSession', r.error.message);
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

window.LifeApp = {
  S: S, loadAll: loadAll, render: render, toast: toast,
  openSheet: openSheet, closeSheet: closeSheet, enterApp: enterApp,
  openBook: openBook, getKv: kvGet, saveKv: kvSet,
  upsertHealth: upsertHealth, upsertActivity: upsertActivity,
  appBase: appBase,
  rateOfDay: rateOfDay, dayEntries: dayEntries, levelOf: levelOf,
  habitsForDay: habitsForDay, activeHabits: activeHabits, corrPairs: corrPairs,
  activeBooks: activeBooks, activeNotes: activeNotes, activePlans: activePlans,
  recentDeleted: recentDeleted, openTrashSheet: openTrashSheet, restoreRow: restoreRow,
  exportBackup: exportBackup, restoreBackup: restoreBackup, fetchBackupRows: fetchBackupRows,
  askConfirm: askConfirm, renderSkeleton: renderSkeleton,
  readSnapshot: readSnapshot, saveSnapshot: saveSnapshot, installSW: installSW
};

boot();
})();
