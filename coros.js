/* COROS 数据接入：OAuth 2.0 + PKCE，直连官方 MCP（已确认允许本域跨域） */
(function () {
'use strict';

const CFG = window.APP_CONFIG.coros;
const KV_KEY = 'coros_auth';
const CLIENT_KEY = 'lifeboard.coros.client';
const VERIFIER_KEY = 'lifeboard.coros.verifier';
const STATE_KEY = 'lifeboard.coros.state';

let cache = null;          // { access_token, refresh_token, expires_at, client_id, last_sync }
let loaded = false;
let busy = false;

/* ---------- 小工具 ---------- */
function b64url(buf) {
  let s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function rand(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a.buffer);
}
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(buf);
}
function form(obj) {
  return Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}
const isToday = s => {
  const d = new Date();
  const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return s === k;
};
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function redirectUri() {
  try {
    if (window.LifeApp && typeof window.LifeApp.appBase === 'function') return window.LifeApp.appBase();
  } catch (e) {}
  return CFG.redirectUri;
}

/* ---------- 客户端注册 ---------- */
async function ensureClientId() {
  try {
    const raw = localStorage.getItem(CLIENT_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.client_id && o.redirect_uri === redirectUri()) return o.client_id;
    }
  } catch (e) {}

  const res = await fetch(CFG.base + '/connect/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CFG.clientName,
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });
  if (!res.ok) throw new Error('注册应用失败（' + res.status + '）');
  const data = await res.json();
  localStorage.setItem(CLIENT_KEY, JSON.stringify({ client_id: data.client_id, redirect_uri: redirectUri() }));
  return data.client_id;
}

/* ---------- 授权 ---------- */
async function connect() {
  if (busy) return;
  busy = true;
  try {
    const clientId = await ensureClientId();
    const verifier = rand(48);
    const challenge = await sha256(verifier);
    const state = 'coros_' + rand(12);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const p = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri(),
      scope: 'openid mcp.tools offline_access',
      state: state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: CFG.base
    });
    location.assign(CFG.base + '/oauth2/authorize?' + p.toString());
  } catch (e) {
    window.LifeApp.toast('无法发起授权：' + (e.message || ''));
    busy = false;
  }
}

async function handleCallback(url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const err = url.searchParams.get('error');
  if (err) throw new Error(url.searchParams.get('error_description') || err);
  if (!code) throw new Error('授权回调缺少 code');

  const saved = sessionStorage.getItem(STATE_KEY);
  if (saved && state !== saved) throw new Error('授权状态不匹配，请重新授权');

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('本地授权凭据已失效，请重新点「连接 COROS」');

  const clientRaw = localStorage.getItem(CLIENT_KEY);
  const clientId = clientRaw ? JSON.parse(clientRaw).client_id : null;
  if (!clientId) throw new Error('未找到应用注册信息，请重新授权');

  const res = await fetch(CFG.base + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
      resource: CFG.base
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('换取令牌失败：' + (data.error_description || data.error || res.status));
  }
  await persist(data, clientId);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  window.LifeApp.toast('COROS 已连接');
}

/* ---------- 令牌管理 ---------- */
async function persist(tok, clientId) {
  cache = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || (cache && cache.refresh_token) || null,
    expires_at: Date.now() + (Number(tok.expires_in || 3600) * 1000),
    client_id: clientId,
    last_sync: (cache && cache.last_sync) || null
  };
  loaded = true;
  await window.LifeApp.saveKv(KV_KEY, cache);
}

async function loadAuth() {
  if (loaded) return cache;
  loaded = true;
  try {
    const v = await window.LifeApp.getKv(KV_KEY);
    if (v && v.access_token) cache = v;
  } catch (e) { console.warn('[coros] load auth', e); }
  return cache;
}

async function ensureFresh() {
  const a = await loadAuth();
  if (!a || !a.access_token) throw new Error('还没有连接 COROS');
  if (Date.now() < (a.expires_at || 0) - 60000) return a;
  if (!a.refresh_token) throw new Error('授权已过期，请重新连接 COROS');

  const res = await fetch(CFG.base + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
      client_id: a.client_id,
      resource: CFG.base
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('续期失败，请重新连接 COROS');
  }
  await persist(data, a.client_id);
  return cache;
}

/* ---------- MCP 调用 ---------- */
let mcpSession = null;
let reqId = 1;

async function mcpPost(token, payload, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer ' + token
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(CFG.base + '/mcp', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
  const sid = res.headers.get('Mcp-Session-Id') || res.headers.get('mcp-session-id');
  if (sid) mcpSession = sid;

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  if (!res.ok && ct.indexOf('event-stream') === -1) {
    throw new Error('MCP 请求失败 ' + res.status + '：' + raw.slice(0, 160));
  }
  if (ct.indexOf('event-stream') !== -1) {
    const lines = raw.split(/\r?\n/);
    for (const ln of lines) {
      if (ln.indexOf('data:') === 0) {
        const body = ln.slice(5).trim();
        if (!body) continue;
        try {
          const j = JSON.parse(body);
          if (j && (j.result !== undefined || j.error)) return j;
        } catch (e) {}
      }
    }
    throw new Error('未能解析 MCP 流式响应');
  }
  try { return JSON.parse(raw); } catch (e) { throw new Error('MCP 响应不是 JSON'); }
}

async function mcpInit(token) {
  mcpSession = null;
  const r = await mcpPost(token, {
    jsonrpc: '2.0', id: reqId++,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'life-board', version: '1.0.0' } }
  });
  if (r.error) throw new Error('MCP 初始化失败：' + (r.error.message || ''));
  try {
    await mcpPost(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSession);
  } catch (e) { /* 通知失败不致命 */ }
  return mcpSession;
}

async function listTools(token) {
  const r = await mcpPost(token, { jsonrpc: '2.0', id: reqId++, method: 'tools/list', params: {} }, mcpSession);
  if (r.error) throw new Error('获取工具列表失败：' + (r.error.message || ''));
  return (r.result && r.result.tools) || [];
}

async function callTool(token, name, args) {
  const r = await mcpPost(token, {
    jsonrpc: '2.0', id: reqId++, method: 'tools/call',
    params: { name: name, arguments: args || {} }
  }, mcpSession);
  if (r.error) throw new Error(r.error.message || 'MCP 调用失败');
  const c = r.result && r.result.content;
  if (Array.isArray(c)) {
    const txt = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
    if (txt) {
      try { return JSON.parse(txt); } catch (e) { return txt; }
    }
    return c;
  }
  return r.result;
}

/* ---------- 固定字段 schema ----------
   不再把嵌套数字全部扁平化（同名会互相覆盖），也不靠数值阈值猜单位。
   每类数据只从声明过的路径取值；单位必须在白名单内，结果还要落在合理区间，
   任一环节不满足就记一条诊断、该字段不写入，避免静默写错数值。 */
const UNIT_ALIAS = {
  's': 's', 'sec': 's', 'secs': 's', 'second': 's', 'seconds': 's',
  'min': 'min', 'mins': 'min', 'minute': 'min', 'minutes': 'min',
  'h': 'h', 'hr': 'h', 'hour': 'h', 'hours': 'h',
  'ms': 'ms', 'millisecond': 'ms', 'milliseconds': 'ms'
};
const TIME_FACTOR = {
  s:   { min: 1 / 60,  sec: 1 },
  min: { min: 1,       sec: 60 },
  h:   { min: 60,      sec: 3600 },
  ms:  { min: 1 / 60000, sec: 0.001 }
};
const DIST_ALIAS = { m: 'm', meter: 'm', meters: 'm', km: 'km', kilometer: 'km', kilometers: 'km', mi: 'mi', mile: 'mi' };
const DIST_FACTOR = { m: 1, km: 1000, mi: 1609.34 };
/* 单位字段按字段族分开找，避免「距离单位」被误当作「时长单位」而误报 */
const TIME_UNIT_PATHS = ['timeUnit', 'sleepUnit', 'durationUnit', 'unit', 'units'];
const DIST_UNIT_PATHS = ['distanceUnit', 'unit', 'units'];
const DATE_PATHS = ['date', 'day', 'sleepDate', 'sleep_date', 'happenDay', 'startTime', 'start_time', 'timestamp'];

/* target: min = 转成分钟（睡眠写库时再换算成小时）；sec = 转成秒；raw = 原值
   min/max 是转换后目标单位的合理区间，用于拦截单位错配 */
const SCHEMAS = {
  sleep: {
    fields: [
      { key: 'sleep_total', target: 'min', unit: 's', min: 120, max: 840,
        paths: ['sleepDuration', 'sleep_duration', 'totalSleepTime', 'total_sleep_time', 'totalSleep', 'sleepTime', 'sleepSeconds'] },
      { key: 'sleep_deep', target: 'min', unit: 's', min: 0, max: 840,
        paths: ['deepSleepDuration', 'deep_sleep_duration', 'deepSleep', 'deepSleepTime', 'sleepDeep'] },
      { key: 'sleep_rem', target: 'min', unit: 's', min: 0, max: 840,
        paths: ['remSleepDuration', 'rem_sleep_duration', 'remSleep', 'remSleepTime', 'sleepRem'] },
      { key: 'sleep_light', target: 'min', unit: 's', min: 0, max: 840,
        paths: ['lightSleepDuration', 'light_sleep_duration', 'lightSleep', 'lightSleepTime', 'sleepLight'] }
    ]
  },
  health: {
    fields: [
      { key: 'hrv', target: 'raw', unit: 'ms', min: 1, max: 300,
        paths: ['hrv', 'hrvValue', 'hrv_value', 'avgHrv', 'overnightHrv', 'rmssd', 'sdnn'] },
      { key: 'resting_hr', target: 'raw', unit: 'bpm', min: 25, max: 120,
        paths: ['restingHeartRate', 'resting_hr', 'restingHr', 'restHr', 'rhr'] },
      { key: 'stress', target: 'raw', unit: 'score', min: 0, max: 100,
        paths: ['stress', 'stressValue', 'stress_value', 'avgStress', 'stressLevel'] },
      { key: 'training_load', target: 'raw', unit: 'score', min: 0, max: 1000,
        paths: ['trainingLoad', 'training_load', 'load', 'exerciseLoad', 'tss'] },
      { key: 'steps', target: 'raw', unit: 'count', min: 0, max: 100000,
        paths: ['steps', 'step', 'totalSteps', 'step_count', 'stepCount'] }
    ]
  },
  activity: {
    fields: [
      { key: 'duration_sec', target: 'sec', unit: 's', min: 60, max: 86400,
        paths: ['duration', 'durationSeconds', 'duration_seconds', 'totalTime', 'elapsedTime', 'workoutTime'] },
      { key: 'distance_m', target: 'm', unit: 'm', min: 0, max: 1000000,
        paths: ['distance', 'distanceMeter', 'distance_m', 'totalDistance'] },
      { key: 'avg_hr', target: 'raw', unit: 'bpm', min: 25, max: 250,
        paths: ['avgHeartRate', 'averageHeartRate', 'avgHr', 'avg_hr'] },
      { key: 'calories', target: 'raw', unit: 'kcal', min: 0, max: 20000,
        paths: ['calorie', 'calories', 'kcal', 'totalCalorie'] }
    ]
  }
};

/* 精确路径读取：大小写不敏感，但绝不遍历未知字段 */
function getByPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const key = Object.keys(cur).find(k => k.toLowerCase() === part.toLowerCase());
    if (key === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}
function readField(item, def) {
  for (const path of def.paths) {
    const v = getByPath(item, path);
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (isFinite(n)) return { value: n, path: path };
  }
  return null;
}
function resolveUnit(item, def) {
  // 标量字段的单位由 schema 固定；时间/距离字段允许数据里显式声明单位，但必须在白名单内
  if (def.target === 'raw') return { unit: def.unit, explicit: false };
  for (const p of (def.target === 'm' ? DIST_UNIT_PATHS : TIME_UNIT_PATHS)) {
    const v = getByPath(item, p);
    if (v === null || v === undefined || v === '') continue;
    const t = String(v).trim().toLowerCase();
    const u = def.target === 'm' ? DIST_ALIAS[t] : UNIT_ALIAS[t];
    if (!u) return { unit: null, raw: String(v), path: p };
    return { unit: u, explicit: true };
  }
  return { unit: def.unit, explicit: false };   // 采用 schema 声明的固定单位
}
function convert(v, unit, def) {
  if (def.target === 'raw') return v;
  if (def.target === 'm') { const f = DIST_FACTOR[unit]; return f ? v * f : null; }
  const f = TIME_FACTOR[unit];
  return f ? v * f[def.target] : null;
}

function dayOf(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(v > 1e12 ? v : v * 1000);
    return isNaN(d) ? null : ymd(d);
  }
  const m = String(v).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  return null;
}

function issueBucket() {
  const m = new Map();
  return {
    add(tool, field, reason, sample) {
      const k = tool + '|' + field + '|' + reason;
      const cur = m.get(k);
      if (cur) cur.count++;
      else m.set(k, { tool: tool, field: field, reason: reason, sample: sample, count: 1 });
    },
    list() { return Array.from(m.values()); }
  };
}

/* 把一个返回条目按固定 schema 映射成写库行；任何异常都落到 issues 而不是悄悄跳过 */
function mapItem(category, item, toolName, issues) {
  const schema = SCHEMAS[category];
  if (!schema || !item || typeof item !== 'object') return null;
  const row = {};
  let mapped = 0;
  for (const def of schema.fields) {
    const found = readField(item, def);
    if (!found) continue;
    const u = resolveUnit(item, def);
    if (!u.unit) {
      issues.add(toolName, def.key, '单位「' + u.raw + '」不在白名单，已跳过', String(found.value));
      continue;
    }
    const val = convert(found.value, u.unit, def);
    if (val === null || !isFinite(val) || val < def.min || val > def.max) {
      issues.add(toolName, def.key,
        '取值 ' + found.value + '（单位 ' + u.unit + '）换算后超出合理区间 ' + def.min + '–' + def.max + '，已跳过',
        found.path);
      continue;
    }
    row[def.key] = Math.round(val);
    mapped++;
  }
  if (!mapped) {
    issues.add(toolName, '(整条)', '返回结构中没有匹配的字段，已跳过。原始字段名：' +
      Object.keys(item).slice(0, 24).join(', '), '');
  }
  if (!mapped) return null;
  if (category !== 'activity') {
    for (const k of ['sleep_total', 'sleep_deep', 'sleep_rem', 'sleep_light']) {
      if (row[k] !== undefined) row[k] = Math.round(row[k] / 6) / 10;  // 分钟 → 小时
    }
  }
  let day = null;
  for (const p of DATE_PATHS) {
    day = dayOf(getByPath(item, p));
    if (day) break;
  }
  return { row: row, day: day, mapped: mapped };
}

/* ---------- 同步 ---------- */
const SLEEP_WORDS = ['sleep', 'sleepdata', 'sleeplog', 'night'];
const HEALTH_WORDS = ['daily', 'health', 'summary', 'metric', 'recovery', 'load', 'stress', 'hrv'];
const ACT_WORDS = ['activit', 'workout', 'session', 'exercise', 'training'];

function hit(name, words) {
  const n = String(name).toLowerCase();
  return words.some(w => n.indexOf(w) !== -1);
}

function argsFor(tool, from, to) {
  const sc = (tool.inputSchema && tool.inputSchema.properties) || {};
  const keys = Object.keys(sc);
  const a = {};
  let hasDate = false;
  keys.forEach(k => {
    const kl = k.toLowerCase();
    if (/^(start|from|begin)(_?(date|day|time))?$/.test(kl)) { a[k] = from; hasDate = true; }
    else if (/^(end|to|until)(_?(date|day|time))?$/.test(kl)) { a[k] = to; hasDate = true; }
    else if (/^(date|day)$/.test(kl)) { a[k] = to; hasDate = true; }
    else if (/(days|limit|count)/.test(kl) && sc[k] && sc[k].type === 'number') { a[k] = 7; }
  });
  if (!hasDate && sc['date']) a['date'] = to;
  return a;
}

async function sync(days) {
  if (busy) throw new Error('正在同步，请稍候');
  busy = true;
  const n = Math.max(1, Math.min(14, days || 3));
  try {
    const a = await ensureFresh();
    const token = a.access_token;
    await mcpInit(token);
    const tools = await listTools(token);
    if (!tools.length) throw new Error('没有获取到可用的数据接口');

    const from = ymd(new Date(Date.now() - (n - 1) * 86400000));
    const to = ymd(new Date());

    const written = new Set();
    const issues = issueBucket();
    const debug = [];
    const samples = [];

    for (const t of tools) {
      const nm = t.name || '';
      const category = hit(nm, SLEEP_WORDS) ? 'sleep'
        : hit(nm, ACT_WORDS) ? 'activity'
        : hit(nm, HEALTH_WORDS) ? 'health' : null;
      if (!category) { debug.push(nm + ': 非数据类工具，跳过'); continue; }

      let payload;
      try {
        payload = await callTool(token, nm, argsFor(t, from, to));
      } catch (e) {
        const msg = e.message || 'fail';
        debug.push(nm + ': ' + msg);
        issues.add(nm, '(整条)', '调用失败：' + msg, '');
        continue;
      }

      const buckets = Array.isArray(payload) ? payload
        : (payload && Array.isArray(payload.data) ? payload.data
        : (payload && Array.isArray(payload.items) ? payload.items
        : (payload && Array.isArray(payload.list) ? payload.list : [payload])));

      let okCount = 0;
      for (const item of buckets) {
        if (!item || typeof item !== 'object') continue;
        if (samples.length < 12) samples.push({ tool: nm, keys: Object.keys(item).slice(0, 30) });
        const m = mapItem(category, item, nm, issues);
        if (!m) continue;
        const day = m.day || to;

        if (category === 'activity') {
          const ext = String(item.id || item.activityId || item.activity_id || item.labelId || item.workoutId ||
            (day + '|' + (item.type || '') + '|' + (m.row.duration_sec || '') + '|' + (m.row.distance_m || '')));
          await window.LifeApp.upsertActivity({
            external_id: ext,
            day: day,
            type: item.type || item.sportType || item.mode || null,
            name: item.name || item.title || item.sportName || null,
            duration_sec: m.row.duration_sec === undefined ? null : m.row.duration_sec,
            distance_m: m.row.distance_m === undefined ? null : m.row.distance_m,
            avg_hr: m.row.avg_hr === undefined ? null : m.row.avg_hr,
            calories: m.row.calories === undefined ? null : m.row.calories
          });
        } else {
          await window.LifeApp.upsertHealth(day, m.row);
          written.add(day);
        }
        okCount++;
      }
      debug.push(nm + ': ' + okCount + '/' + buckets.length + ' 条写入');
    }

    // 同步结果 + 未识别字段落库；诊断页与 toast 都会把它报给用户
    cache.last_sync = new Date().toISOString();
    const warnings = issues.list();
    cache.last_warnings = warnings;
    await window.LifeApp.saveKv(KV_KEY, cache);
    try {
      await window.LifeApp.saveKv('coros_last_run', {
        at: cache.last_sync, tools: tools.map(t => t.name),
        log: debug, warnings: warnings, samples: samples,
        schemaFields: Object.keys(SCHEMAS).reduce((o, k) => { o[k] = SCHEMAS[k].fields.map(f => f.key); return o; }, {})
      });
    } catch (e) {}

    return { days: written.size, warnings: warnings, tools: tools.length };
  } finally {
    busy = false;
  }
}

/* ---------- 对外 ---------- */
function status() {
  const c = cache;
  let last = '';
  if (c && c.last_sync) {
    const d = new Date(c.last_sync);
    last = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // 令牌过期但仍有 refresh_token 时不算「已连接」到可用状态以外：ensureFresh 会自动续期
  const usable = !!(c && c.access_token && (c.refresh_token || Date.now() < (c.expires_at || 0)));
  const w = (c && c.last_warnings) || [];
  return { connected: usable, lastSync: last, warnCount: w.length };
}
function warnings() { return (cache && cache.last_warnings) || []; }

async function afterLogin() {
  await loadAuth();
  const S = window.LifeApp.S;
  if (!cache || !cache.access_token) return;
  const t = ymd(new Date());
  if (S.health[t]) return;                       // 今天已有数据
  if (cache.last_sync && (Date.now() - new Date(cache.last_sync).getTime()) < 6 * 3600 * 1000) return;
  try {
    const res = await sync(2);
    if (res.days > 0) { await window.LifeApp.loadAll(); window.LifeApp.render(); }
  } catch (e) { console.warn('[coros] auto sync skipped:', e.message); }
}

window.Coros = { connect, handleCallback, sync, status, warnings, afterLogin, mapItem, issueBucket, SCHEMAS };
})();
