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
  const result = r.result || {};
  if (result.structuredContent !== undefined) {
    return { kind: 'json', value: result.structuredContent,
      raw: JSON.stringify(result.structuredContent).slice(0, 400) };
  }
  let txt = '';
  const c = result.content;
  if (Array.isArray(c)) txt = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
  else if (typeof result === 'string') txt = result;
  else return { kind: 'json', value: result, raw: JSON.stringify(result).slice(0, 400) };

  const t = txt.trim();
  // COROS 把整段报告用 JSON.stringify 包了一层，先剥掉字符串字面量外壳
  if (t.charAt(0) === '"') {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return { kind: 'text', value: parsed, raw: parsed.slice(0, 400) };
    } catch (e) {}
  }
  try {
    const j = JSON.parse(t);
    return { kind: 'json', value: j, raw: t.slice(0, 400) };
  } catch (e) {}
  return { kind: 'text', value: txt, raw: txt.slice(0, 400) };
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

/* ---------- 同步 ----------
   COROS 官方 MCP 返回的是给 LLM 阅读的纯文本报告（实测 2026-11），不是结构化 JSON；
   日期参数为 yyyyMMdd，报告内日期为 yyyy-MM-dd / yyyyMMdd。这里按工具名精确解析，
   每个字段都做合理区间校验；不认识的内容只记诊断，不写库。 */
const READ_TOOLS = {
  queryDailyHealthData: 'daily',
  querySleepOverview: 'sleepOverview',
  querySleepHrv: 'hrv',
  queryRestingHeartRate: 'rhr',
  queryStressLevel: 'stress',
  queryTrainingLoadAssessment: 'load',
  querySportRecords: 'sport'
};
const JSON_CATEGORY = {
  queryDailyHealthData: 'health', querySleepOverview: 'sleep',
  querySleepHrv: 'health', queryRestingHeartRate: 'health',
  queryStressLevel: 'health', queryTrainingLoadAssessment: 'health',
  querySportRecords: 'activity'
};
/* 白名单之外的工具绝不调用：create / update / upload / schedule 会改用户 COROS 数据 */

function num(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}
function minutesOf(s) {
  if (s === null || s === undefined) return null;
  const str = String(s);
  const h = /(\d+(?:\.\d+)?)\s*h(?:our)?s?/i.exec(str);
  const m = /(\d+(?:\.\d+)?)\s*min/i.exec(str);
  if (!h && !m) return num(str);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}
function clockSeconds(s) {
  if (!s) return null;
  const parts = String(s).trim().split(':').map(Number);
  if (!parts.length || parts.some(x => !isFinite(x))) return null;
  let sec = 0;
  for (const x of parts) sec = sec * 60 + x;
  return sec;
}
function isoDay(s) {
  const t = String(s || '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}
function compactDay(s) { return String(s).replace(/-/g, ''); }
function hours(min) { return Math.round(min / 6) / 10; }
function inRange(v, lo, hi) { return v !== null && isFinite(v) && v >= lo && v <= hi; }
function grab(re, text) { const m = re.exec(text); return m ? m[1] : null; }

function parseDailyHealth(text, issues) {
  const out = [];
  const re = /---\s*(\d{8})\s*---/g;
  const marks = []; let m;
  while ((m = re.exec(text))) marks.push({ day: isoDay(m[1]), start: re.lastIndex, len: m[0].length, head: m[0] });
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].start - marks[i + 1].head.length : text.length;
    const block = text.slice(marks[i].start, stop);
    const row = {};
    const steps = num(grab(/Steps:\s*([\d,]+)/, block));
    if (inRange(steps, 0, 100000)) row.steps = Math.round(steps);
    const stress = num(grab(/Stress:\s*Avg\s*([\d,]+)/, block));
    if (inRange(stress, 0, 100)) row.stress = Math.round(stress);
    const total = minutesOf(grab(/\bTotal:\s*([^|\n]+)/i, block));
    if (inRange(total, 120, 840)) row.sleep_total = hours(total);
    const deep = minutesOf(grab(/\bDeep:\s*([^|\n]+)/i, block));
    if (inRange(deep, 0, 840)) row.sleep_deep = hours(deep);
    const light = minutesOf(grab(/\bLight:\s*([^|\n]+)/i, block));
    if (inRange(light, 0, 840)) row.sleep_light = hours(light);
    const rem = minutesOf(grab(/\bREM:\s*([^|\n]+)/i, block));
    if (inRange(rem, 0, 840)) row.sleep_rem = hours(rem);
    if (Object.keys(row).length) out.push({ day: marks[i].day, row: row });
    else issues.add('queryDailyHealthData', '(整条)', '该日报告没有可识别字段', marks[i].day);
  }
  return out;
}

function parseSleepOverview(text) {
  const out = [];
  for (const b of String(text).split(/\n\s*\n/)) {
    const dm = /^\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(b);
    if (!dm) continue;
    const main = minutesOf(grab(/Main Sleep \(asleep\):\s*([^\n]+)/, b));
    const daily = minutesOf(grab(/Daily Sleep:\s*([^\n]+)/, b));
    const total = inRange(main, 120, 840) ? main : (inRange(daily, 120, 840) ? daily : null);
    if (total === null) continue;
    const row = { sleep_total: hours(total) };
    [['sleep_deep', /Deep Sleep Ratio:\s*(\d+)\s*%/i],
     ['sleep_light', /Light Sleep Ratio:\s*(\d+)\s*%/i],
     ['sleep_rem', /REM Ratio:\s*(\d+)\s*%/i]].forEach(function (d) {
      const p = num(grab(d[1], b));
      if (inRange(p, 0, 100)) row[d[0]] = hours(total * p / 100);
    });
    out.push({ day: dm[1], row: row });
  }
  return out;
}

function parseDailyPairs(text, re, key, lo, hi) {
  const out = []; let m;
  const rx = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
  while ((m = rx.exec(String(text)))) {
    const day = isoDay(m[1]), v = num(m[2]);
    if (day && inRange(v, lo, hi)) out.push({ day: day, row: (function () { const r = {}; r[key] = Math.round(v); return r; })() });
  }
  return out;
}
function parseHrv(text) {
  const seg = String(text).split(/Sleep HRV Time Series/i)[0];
  return parseDailyPairs(seg, /(\d{4}-\d{2}-\d{2}):\s*\n\s*HRV Avg:\s*(\d+(?:\.\d+)?)\s*ms/i, 'hrv', 1, 300);
}
function parseRestingHr(text) {
  return parseDailyPairs(text, /(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/i, 'resting_hr', 25, 120);
}
function parseStress(text) {
  return parseDailyPairs(text, /(\d{4}-\d{2}-\d{2}):\s*\n\s*Average Stress:\s*(\d+)/i, 'stress', 0, 100);
}
function parseLoad(text) {
  const out = [];
  for (const b of String(text).split(/\n\s*\n/)) {
    const dm = /^\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(b);
    const v = num(grab(/Short-Term Load:\s*(\d+)/, b));
    if (dm && inRange(v, 0, 1000)) out.push({ day: isoDay(dm[1]), row: { training_load: Math.round(v) } });
  }
  return out;
}
function parseSportRecords(text) {
  const out = [];
  const re = /^\s*\d+\.\s*(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const marks = []; let m;
  while ((m = re.exec(text))) marks.push({ name: m[1].trim(), day: m[2], start: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const b = text.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : text.length);
    const ext = grab(/LabelId:\s*(\S+)/, b);
    const row = {
      external_id: ext || (marks[i].day + '|' + marks[i].name),
      day: marks[i].day,
      name: marks[i].name,
      type: grab(/SportType:\s*(\S+)/, b) || null
    };
    const dur = clockSeconds(grab(/Duration:\s*([^\s|]+)/, b));
    if (inRange(dur, 60, 86400)) row.duration_sec = Math.round(dur);
    const km = num(grab(/Distance:\s*([\d.,]+)\s*km/i, b));
    if (inRange(km, 0, 1000)) row.distance_m = Math.round(km * 1000);
    const hr = num(grab(/Avg HR:\s*(\d+)\s*bpm/i, b));
    if (inRange(hr, 25, 250)) row.avg_hr = Math.round(hr);
    const kcal = num(grab(/Calories:\s*([\d,]+)\s*kcal/i, b));
    if (inRange(kcal, 0, 20000)) row.calories = Math.round(kcal);
    out.push(row);
  }
  return out;
}

function mergeHealth(map, entries, fillOnly) {
  entries.forEach(function (e) {
    if (!e.day) return;
    const cur = map[e.day] = map[e.day] || {};
    Object.keys(e.row).forEach(function (k) {
      if (!fillOnly || cur[k] === undefined) cur[k] = e.row[k];
    });
  });
}

async function sync(days) {
  if (busy) { const soft = new Error('已有同步在进行，请稍候'); soft.soft = true; throw soft; }
  busy = true;
  const n = Math.max(1, Math.min(14, days || 7));
  let phase = '准备';
  const debug = [], issues = issueBucket(), samples = [], toolsUsed = [];
  const health = {}, activities = [];
  try {
    phase = '检查授权';
    const a = await ensureFresh();
    const token = a.access_token;
    phase = '连接 COROS';
    await mcpInit(token);
    phase = '读取工具列表';
    const tools = await listTools(token);
    if (!tools.length) throw new Error('没有获取到可用的数据接口');

    const from = ymd(new Date(Date.now() - (n - 1) * 86400000));
    const to = ymd(new Date());
    const wanted = {};
    tools.forEach(function (t) { if (t && READ_TOOLS[t.name]) wanted[t.name] = t; });

    for (const nm of Object.keys(READ_TOOLS)) {
      const t = wanted[nm];
      if (!t) { debug.push(nm + ': 官方未提供，跳过'); continue; }
      const allowed = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
      const cand = { days: n, startDate: compactDay(from), endDate: compactDay(to), limit: 50 };
      const args = {};
      allowed.forEach(function (k) { if (cand[k] !== undefined) args[k] = cand[k]; });
      phase = '读取 ' + nm;
      let res;
      try { res = await callTool(token, nm, args); }
      catch (e) {
        const msg = e.message || 'fail';
        debug.push(nm + ': 调用失败 ' + msg);
        issues.add(nm, '(整条)', '调用失败：' + msg, JSON.stringify(args));
        continue;
      }
      toolsUsed.push(nm);
      samples.push({ tool: nm, kind: res.kind, args: args, preview: String(res.raw || '').slice(0, 400) });

      if (res.kind === 'json') {
        // 兼容：若官方改回结构化返回，仍走固定 schema 白名单
        const category = JSON_CATEGORY[nm] || 'health';
        const v = res.value;
        const arr = Array.isArray(v) ? v
          : (v && (Array.isArray(v.data) ? v.data : Array.isArray(v.items) ? v.items : Array.isArray(v.list) ? v.list : [v]));
        let cnt = 0;
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const mm = mapItem(category, item, nm, issues);
          if (!mm) continue;
          const day = mm.day || to;
          if (category === 'activity') {
            activities.push(Object.assign({
              external_id: String(item.id || item.activityId || item.labelId || (day + '|' + cnt)),
              day: day, name: item.name || item.title || null, type: item.type || item.sportType || null
            }, mm.row));
          } else mergeHealth(health, [{ day: day, row: mm.row }], false);
          cnt++;
        }
        debug.push(nm + ': JSON 路径 ' + cnt + ' 条');
        continue;
      }

      const text = String(res.value || '');
      if (/must not be blank|must be in yyyyMMdd|anomalies detected|High risk of session/i.test(text)) {
        debug.push(nm + ': 参数被拒 ' + text.slice(0, 120));
        issues.add(nm, '(整条)', '参数被官方拒绝：' + text.slice(0, 160), JSON.stringify(args));
        continue;
      }
      let entries = [], acts = [], fill = false;
      switch (READ_TOOLS[nm]) {
        case 'daily':        entries = parseDailyHealth(text, issues); break;
        case 'sleepOverview':entries = parseSleepOverview(text); fill = true; break;
        case 'hrv':          entries = parseHrv(text); break;
        case 'rhr':          entries = parseRestingHr(text); break;
        case 'stress':       entries = parseStress(text); break;
        case 'load':         entries = parseLoad(text); break;
        case 'sport':        acts = parseSportRecords(text); break;
      }
      mergeHealth(health, entries, fill);
      acts.forEach(function (r) { activities.push(r); });
      debug.push(nm + ': 解析出 ' + (entries.length || acts.length) + ' 条');
    }

    phase = '写入云端';
    const written = new Set();
    const writeErrors = [];
    // 单日/单条写入失败不应让整轮同步归零；记录诊断后继续写其余数据。
    for (const day of Object.keys(health)) {
      try {
        await window.LifeApp.upsertHealth(day, Object.assign({ source: 'coros' }, health[day]));
        written.add(day);
      } catch (e) {
        const why = String((e && e.message) || e);
        writeErrors.push(day + '：' + why);
        debug.push(day + ': 写入失败 ' + why);
        issues.add('写入云端', day, '写入失败：' + why, null);
      }
    }
    for (const row of activities) {
      try { await window.LifeApp.upsertActivity(row); }
      catch (e) {
        const why = String((e && e.message) || e);
        writeErrors.push('运动 ' + row.external_id + '：' + why);
        issues.add('写入云端', 'activity', '写入失败：' + why, null);
      }
    }
    if (Object.keys(health).length && !written.size) {
      throw new Error('全部日期写入失败：' + (writeErrors[0] || '未知原因'));
    }
    debug.push('写入 ' + written.size + ' 天身体数据 / ' + activities.length + ' 条运动' +
      (writeErrors.length ? '，其中 ' + writeErrors.length + ' 项失败' : ''));

    phase = '保存诊断';
    const warnings = issues.list();
    cache.last_sync = new Date().toISOString();
    cache.last_warnings = warnings;
    await window.LifeApp.saveKv(KV_KEY, cache);
    await window.LifeApp.saveKv('coros_last_run', {
      at: cache.last_sync, ok: true, phase: '完成', tools: toolsUsed,
      log: debug, warnings: warnings, samples: samples,
      parsed: { healthDays: written.size, activities: activities.length, days: Object.keys(health) }
    });
    return { days: written.size, activities: activities.length, warnings: warnings, tools: toolsUsed.length };
  } catch (e) {
    const msg = '[' + phase + '] ' + (e.message || '未知错误');
    try {
      await window.LifeApp.saveKv('coros_last_run', {
        at: new Date().toISOString(), ok: false, phase: phase, error: msg,
        log: debug, samples: samples, warnings: issues.list()
      });
    } catch (x) {}
    const wrapped = new Error(msg);
    wrapped.soft = !!e.soft;
    throw wrapped;
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

async function diagnostics() {
  try { return await window.LifeApp.getKv('coros_last_run'); } catch (e) { return null; }
}

window.Coros = {
  connect: connect, handleCallback: handleCallback, sync: sync, status: status,
  warnings: warnings, diagnostics: diagnostics, afterLogin: afterLogin,
  mapItem: mapItem, issueBucket: issueBucket, SCHEMAS: SCHEMAS, READ_TOOLS: READ_TOOLS,
  parseDailyHealth: parseDailyHealth, parseSleepOverview: parseSleepOverview,
  parseHrv: parseHrv, parseRestingHr: parseRestingHr, parseStress: parseStress,
  parseLoad: parseLoad, parseSportRecords: parseSportRecords,
  minutesOf: minutesOf, clockSeconds: clockSeconds
};
})();
