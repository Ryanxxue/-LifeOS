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

window.Weread = { parse: parse };
})();
