/* 微信读书粘贴解析：把复制出来的划线文本拆成 书名 / 作者 / 章节 / 划线 */
(function () {
'use strict';

const NOISE = [
  /^来自\s*微信读书/,
  /^微信读书/,
  /^——\s*摘自/,
  /^--\s*摘自/,
  /^摘自《/,
  /^第\s*\d+\s*页/,
  /^\d+\s*\/\s*\d+$/,
  /^位置\s*\d+/,
  /^本章完$/,
  /^完$/,
  /^\.{3,}$/,
  /^-{3,}$/
];

function clean(s) {
  return String(s)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isNoise(line) {
  return NOISE.some(re => re.test(line));
}

function looksLikeHeading(line) {
  if (!line) return false;
  if (/^第[一二三四五六七八九十百千0-9]+\s*[章节篇回]/.test(line)) return true;
  if (/^#{1,3}\s+/.test(line)) return true;
  if (/^[【\[]/.test(line) && line.length < 24 && /[】\]]$/.test(line)) return true;
  // 短且无句末标点，多半是章节名
  if (line.length <= 14 && !/[。！？；，、,.!?;:]$/.test(line) && !/[。！？]/.test(line)) return true;
  return false;
}

function splitTitle(line) {
  // 《书名》 作者   /  《书名》
  let m = line.match(/^《(.+?)》\s*(.*)$/);
  if (m) return { title: m[1].trim(), author: (m[2] || '').replace(/^[-—·\s]+/, '').trim() };
  // 书名 - 作者 / 书名 — 作者 / 书名 | 作者
  m = line.match(/^(.+?)\s*[-—–|·]{1,2}\s*(.+)$/);
  if (m && m[1].length <= 40) return { title: m[1].trim(), author: m[2].trim() };
  return { title: line.trim(), author: '' };
}

function parse(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(clean)
    .filter(l => l && !isNoise(l));

  const out = { title: '', author: '', notes: [] };
  if (!lines.length) return out;

  let i = 0;

  // 1) 末尾的「——摘自《书名》」优先作为书名来源
  for (let k = lines.length - 1; k >= 0; k--) {
    const m = lines[k].match(/摘自《(.+?)》/);
    if (m) { out.title = m[1].trim(); lines.splice(k, 1); break; }
  }

  // 2) 第一行是标题行？（书名号或破折号是强信号，优先于章节判断）
  if (!out.title && lines.length > 1) {
    const first = lines[0];
    const isBookMark = /^《.+?》/.test(first);
    const isDashTitle = /^(.{1,40}?)\s*[-—–]{1,2}\s*\S/.test(first) && !/[。！？]$/.test(first);
    if (isBookMark || isDashTitle) {
      const t = splitTitle(first);
      out.title = t.title;
      out.author = t.author;
      i = 1;
    }
  } else if (out.title) {
    i = 0;
  }

  // 3) 余下逐行归档
  let chapter = '';
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (looksLikeHeading(line) && line.length <= 40) {
      chapter = line.replace(/^#{1,3}\s+/, '').trim();
      continue;
    }
    // 单行里可能塞了多句，超过 240 字就按句号拆
    if (line.length > 240) {
      line.split(/(?<=[。！？])/).map(clean).filter(Boolean).forEach(t => {
        out.notes.push({ chapter: chapter, text: t });
      });
    } else {
      out.notes.push({ chapter: chapter, text: line });
    }
  }

  // 4) 若第一条其实是书名行（因为只有一个书名 + 若干划线）
  if (!out.title && out.notes.length) {
    out.title = '未命名书籍';
  }

  return out;
}

/* ---- 微信读书 Agent Gateway（官方 API）----------------------------------
   网关地址固定，鉴权用 Bearer wrk-xxx。浏览器直连会被 CORS 拦截（网关只放行
   https://weread.qq.com），所以前端保留 fetch 作为「将来放开直连」的路径，
   实际同步由 WorkBuddy 服务端代拉；这里另提供 parseShelf 解析 API 响应。 */
const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';

async function fetchShelf(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('还没有配置微信读书 API Key');
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({ api_name: '/shelf/sync', skill_version: '1.0.5' })
  });
  if (!res.ok) throw new Error('网关返回 HTTP ' + res.status);
  const text = await res.text();
  const list = parseShelf(text);
  if (!list.length) throw new Error('没有从响应里解析到书籍');
  return list;
}

/* 网关返回可能是纯 JSON、包一层的 {data:...}，甚至是 LLM 可读文本里的 JSON 片段，
   这里做宽松解析，只取能识别成书的对象。 */
function findBookArrays(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    const looksBooks = node.length && node.every(x => x && typeof x === 'object' &&
      (x.title || x.bookName || x.name || x.bookInfo));
    if (looksBooks) out.push(node);
    else node.forEach(x => findBookArrays(x, out, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    Object.keys(node).forEach(k => findBookArrays(node[k], out, depth + 1));
  }
}

function parseShelf(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  let data = null;
  try { data = JSON.parse(s); }
  catch (e) {
    // 文本报告里夹着 JSON：取第一个 { 或 [ 到最后一个 } 或 ]
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    const c = s.indexOf('['), d = s.lastIndexOf(']');
    const start = (a >= 0 && (c < 0 || a < c)) ? a : c;
    const end = (a >= 0 && (c < 0 || a < c)) ? b : d;
    if (start >= 0 && end > start) { try { data = JSON.parse(s.slice(start, end + 1)); } catch (e2) {} }
  }
  const arrays = [];
  findBookArrays(data, arrays, 0);
  const rows = [];
  arrays.forEach(arr => arr.forEach(b => {
    const info = b.bookInfo || b.book || b || {};
    const title = String(info.title || b.title || b.bookName || info.bookName || b.name || '').trim();
    if (!title) return;
    const author = String(info.author || b.author || info.creator || '').trim();
    const externalId = String(info.bookId || b.bookId || info.id || b.id || '').trim();
    const progress = Number(b.progress || info.progress || b.readProgress || 0) || 0;
    rows.push({
      title: title,
      author: author || null,
      external_id: externalId || null,
      status: progress >= 100 ? 'done' : 'reading',
      progress: Math.min(100, Math.round(progress)),
      source: 'weread'
    });
  }));
  // 同一本书可能在多个数组里重复出现
  const seen = new Set();
  return rows.filter(r => {
    const k = r.external_id || r.title;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

window.Weread = { parse: parse, parseShelf: parseShelf, fetchShelf: fetchShelf, GATEWAY: GATEWAY };
})();
