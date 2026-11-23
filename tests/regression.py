#!/usr/bin/env python3
"""生活记录面板 —— 走真实 DOM 点击的回归测试。

用法：先在项目根目录跑 `python3 build.py`，再跑 `python3 tests/regression.py`。
原理：把发布用单文件 index.html 复制一份，在 app.js 之前注入一个内存版云 SDK mock，
      用 Chrome headless 打开并断言，最后从 --dump-dom 里读回结果。
      断言全部通过才退出 0；任何 FAIL 或运行异常都退出 1。
"""
import base64
import html as htmlmod
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'index.html')
OUT = os.path.join(HERE, 'regression.html')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

MOCK = r'''
(function () {
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayAt(n) { const x = new Date(); x.setDate(x.getDate() + n); return ymd(x); }
  const store = {
    habits: [
      { id: 1, owner_id: 'u1', name: '早起', icon: 'sun', color: '#FF9F0A', target: '每天', sort_order: 0, archived: false, created_at: '2024-01-01T00:00:00Z' },
      { id: 2, owner_id: 'u1', name: '阅读', icon: 'book', color: '#0A84FF', target: '每天', sort_order: 1, archived: false, created_at: '2024-01-01T00:00:00Z' },
      { id: 3, owner_id: 'u1', name: '运动', icon: 'run', color: '#30D158', target: '每天', sort_order: 2, archived: false, created_at: '2024-01-01T00:00:00Z' }
    ],
    checkins: [
      { id: 1, habit_id: 1, day: dayAt(-3) },
      { id: 2, habit_id: 2, day: dayAt(-3) },
      { id: 3, habit_id: 1, day: dayAt(-2) },
      { id: 4, habit_id: 1, day: dayAt(-1) },
      { id: 5, habit_id: 2, day: dayAt(-1) },
      { id: 6, habit_id: 3, day: dayAt(-1) }
    ],
    health_daily: [
      { id: 1, day: dayAt(-4), sleep_total: 7.0, hrv: 55 },
      { id: 2, day: dayAt(-3), sleep_total: 7.5, hrv: 60 },
      { id: 3, day: dayAt(-2), sleep_total: 8.0, hrv: 65 },
      { id: 4, day: dayAt(-1), sleep_total: 6.5, hrv: 50 }
    ],
    activities: [
      { id: 301, owner_id: 'u1', external_id: '481605761542160886', day: dayAt(-1) + 'T00:00:00Z',
        type: '101', name: 'Indoor Run', duration_sec: 2699, distance_m: '10010.0', avg_hr: 173, calories: 531 },
      { id: 302, owner_id: 'u1', external_id: '481518307420176485', day: dayAt(-1) + 'T00:00:00Z',
        type: '101', name: 'Indoor Run', duration_sec: 1427, distance_m: '5000.0', avg_hr: 168, calories: 271 }
    ],
    books: [
      { id: 11, owner_id: 'u1', title: '反脆弱', author: '塔勒布', status: 'reading', progress: 0, source: 'weread', created_at: '2024-01-01T00:00:00Z' }
    ],
    notes: [
      { id: 101, owner_id: 'u1', book_id: 11, chapter: '', content: '第一条已有划线内容。', created_at: '2024-01-01T00:00:00Z' },
      { id: 102, owner_id: 'u1', book_id: 11, chapter: '', content: '另一条划线。', created_at: '2024-01-01T00:00:00Z' }
    ],
    study_plans: [
      { id: 21, owner_id: 'u1', title: '每周读 3 次专业书', target_per_week: 3, total_weeks: null, sort_order: 0, archived: false, created_at: '2024-01-01T00:00:00Z' }
    ],
    study_logs: [],
    app_kv: []
  };
  let seq = 1000;
  const clone = o => JSON.parse(JSON.stringify(o));
  function run(query) {
    const t = query.t;
    if (window.__MOCK__ && window.__MOCK__.failTable === t && query.op === 'select') {
      throw new Error('injected select failure: ' + t);
    }
    const list = store[t] || (store[t] = []);
    const match = row => query.filters.every(f => {
      const rv = row[f[0]];
      if (f[1] === 'eq') {
        if (f[2] === null) return rv === null || rv === undefined;
        return String(rv) === String(f[2]);
      }
      if (f[1] === 'gte') return String(rv) >= String(f[2]);
      if (f[1] === 'lte') return String(rv).slice(0, 10) <= String(f[2]);
      return true;
    });
    if (query.op === 'select') {
      let rows = list.filter(match).map(clone);
      if (window.__MOCK__ && window.__MOCK__.hideLastInserted && query.t === 'habits' &&
          query.filters.some(f => f[0] === 'id' && String(f[2]) === String(window.__MOCK__.lastInsertId))) rows = [];
      if (query.lim) rows = rows.slice(0, query.lim);
      // 服务端分页：PostgREST 的 range 两端都含
      if (query.rng) rows = rows.slice(query.rng[0], query.rng[1] + 1);
      return rows;
    }
    if (query.op === 'insert') {
      const out = [];
      for (const p of query.payload) {
        const r = Object.assign({}, p);
        r.id = ++seq;
        if (window.__MOCK__ && window.__MOCK__.hideLastInserted) window.__MOCK__.lastInsertId = r.id;
        r.owner_id = (window.__MOCK__ && window.__MOCK__.forceOwner) || 'u1';
        r.created_at = r.created_at || new Date().toISOString();
        if (t === 'study_logs' && store[t].some(x => String(x.plan_id) === String(r.plan_id) && x.day === r.day)) {
          throw new Error('duplicate key value violates unique constraint 23505 study_logs_dedupe_idx');
        }
        if (t === 'notes' && store[t].some(x => String(x.book_id) === String(r.book_id) && x.content === r.content)) {
          throw new Error('duplicate key value violates unique constraint 23505 notes_dedupe_idx');
        }
        // 复现线上真实约束：health_daily(owner_id, day) / activities(owner_id, external_id)
        if (t === 'health_daily' && store[t].some(x => String(x.day).slice(0, 10) === String(r.day).slice(0, 10))) {
          throw new Error('duplicate key value violates unique constraint "health_daily_owner_id_day_key"');
        }
        if (t === 'activities' && store[t].some(x => String(x.external_id) === String(r.external_id))) {
          throw new Error('duplicate key value violates unique constraint "activities_owner_id_external_id_key"');
        }
        if (t === 'books') {
          const nt = String(r.title || '').trim().toLowerCase();
          if (store[t].some(x => !x.deleted_at && String(x.title || '').trim().toLowerCase() === nt)) {
            throw new Error('duplicate key value violates unique constraint "books_owner_title_key"');
          }
          if (r.external_id && store[t].some(x => !x.deleted_at && String(x.external_id) === String(r.external_id))) {
            throw new Error('duplicate key value violates unique constraint "books_owner_ext_key"');
          }
        }
        store[t].push(r);
        out.push(clone(r));
      }
      return out;
    }
    if (query.op === 'update') {
      /* 模拟 RLS 把目标行过滤掉：PostgREST 会返回 200 + 空数组，且数据不变。
         前端必须把这当成失败，不能拿「没返回行」当成功继续改内存。 */
      if (window.__MOCK__ && window.__MOCK__.dropUpdates === t) return [];
      const out = [];
      list.forEach(row => { if (match(row)) { Object.assign(row, query.payload); out.push(clone(row)); } });
      return out;
    }
    if (query.op === 'delete') {
      const out = [];
      for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) out.push(clone(list.splice(i, 1)[0]));
      return out;
    }
    return [];
  }
  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.filters = []; this.payload = null; this.lim = 0; this.rng = null; }
    select() { return this; }
    order() { return this; }
    range(from, to) { this.rng = [from, to]; return this; }
    gte(k, v) { this.filters.push([k, 'gte', v]); return this; }
    lte(k, v) { this.filters.push([k, 'lte', v]); return this; }
    eq(k, v) { this.filters.push([k, 'eq', v]); return this; }
    limit(n) { this.lim = n; return this; }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    then(resolve) {
      try { resolve({ data: run(this), error: null }); }
      catch (e) { resolve({ data: null, error: { message: e.message } }); }
      return Promise.resolve();
    }
  }
  window.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      database: { from: t => new Q(t) },
      auth: {
        getSession: async () => ({ data: { user: { id: 'u1', name: '测试用户', email: 't@test.local' } }, error: null }),
        signOut: async () => ({ error: null }),
        signInWithOAuth: async () => ({ data: { url: '' }, error: null }),
        sendOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async () => ({ data: {}, error: null })
      }
    })
  };
  window.__STORE__ = store;
  window.__dayAt__ = dayAt;
  /* 故障注入：模拟「云端把写入落到匿名身份」与「单张表查询失败」 */
  window.__MOCK__ = { forceOwner: null, failTable: null, dropUpdates: null, hideLastInserted: false, lastInsertId: null,
    queries: [] };
})();
'''

TEST = r'''
(async function () {
  const out = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tick = () => sleep(40);
  const ok = (name, cond, extra) => out.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  const q1 = s => document.querySelector(s);
  function goTab(k) { const b = q1('#tabbar [data-act="tab"][data-id="' + k + '"]'); if (b) b.click(); }
  function goMe() { q1('#btn-me').click(); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayAt(n) { const x = new Date(); x.setDate(x.getDate() + n); return ymd(x); }

  try {
    for (let i = 0; i < 150; i++) {
      if (window.LifeApp && window.LifeApp.S && window.LifeApp.S.user &&
          q1('#view-today') && q1('#view-today').innerHTML.length > 50) break;
      await sleep(20);
    }
    const S = window.LifeApp.S;
    const store = window.__STORE__;
    window.confirm = function () { window.__nativeConfirmCalled = (window.__nativeConfirmCalled || 0) + 1; return false; };

    ok('启动：登录态与今日页渲染', !!S.user && q1('#view-today').innerHTML.indexOf('今日打卡') >= 0);

    /* --- 阅读与学习合并页 --- */
    ok('合并页：底部 4 个标签且无独立阅读/学习入口',
       document.querySelectorAll('#tabbar .tab').length === 4 &&
       !q1('#tabbar [data-id="reading"]') && !q1('#tabbar [data-id="study"]') &&
       !!q1('#tabbar [data-id="library"]'),
       'tabs=' + document.querySelectorAll('#tabbar .tab').length);
    goTab('library');
    ok('合并页：书架与学习计划在同一页',
       !q1('#view-library').hidden &&
       !!q1('#view-library [data-act="openbook"]') &&
       !!q1('#view-library [data-act="logstudy"]') &&
       /阅读与学习|阅读·学习/.test(q1('#view-library').textContent));
    ok('合并页：旧的阅读/学习独立容器已移除', !q1('#view-reading') && !q1('#view-study'));
    window.LifeApp.go('reading');
    ok('合并页：旧 view 别名 reading 落到 library', S.view === 'library');
    window.LifeApp.go('study');
    ok('合并页：旧 view 别名 study 落到 library', S.view === 'library');

    /* --- 日历页运动记录 --- */
    goTab('calendar');
    ok('日历：有运动的日期带运动类型图标（不再是绿点）',
       !!q1('#view-calendar .cal-cell.hasact') &&
       !!q1('#view-calendar .cal-cell.hasact .act-badge svg') &&
       !/绿点/.test(q1('#view-calendar').textContent) &&
       /运动 \d+ 次/.test(q1('#view-calendar').textContent));
    const actDay = dayAt(-1);
    const calCell = q1('#view-calendar [data-act="calday"][data-id="' + actDay + '"]');
    if (calCell) calCell.click(); else { S.selDay = actDay; window.LifeApp.render(); }
    await tick();
    ok('日历：选中日展示 2 条运动明细',
       q1('#view-calendar') && document.querySelectorAll('#view-calendar .actrow').length === 2,
       'rows=' + document.querySelectorAll('#view-calendar .actrow').length);
    ok('日历：运动字段换算与中文名正确',
       /室内跑步/.test(q1('#view-calendar').textContent) &&
       /45 分钟/.test(q1('#view-calendar').textContent) &&
       /10\.01 km/.test(q1('#view-calendar').textContent) &&
       /531 kcal/.test(q1('#view-calendar').textContent));
    const noAct = dayAt(-2);
    const noCell = q1('#view-calendar [data-act="calday"][data-id="' + noAct + '"]');
    if (noCell) noCell.click(); else { S.selDay = noAct; window.LifeApp.render(); }
    await tick();
    ok('日历：无运动的日期给出空态',
       /这一天没有运动记录/.test(q1('#view-calendar').textContent));
    ok('P0-1 状态主键已归一化为字符串', typeof S.books[0].id === 'string' && typeof S.habits[0].id === 'string',
       'book=' + typeof S.books[0].id + ' habit=' + typeof S.habits[0].id);

    /* --- P0-1：全部走真实 DOM 点击 --- */
    goTab('library');
    const cover = q1('#view-library [data-act="openbook"]');
    ok('P0-1 DOM 的 data-id 是字符串', !!cover && typeof cover.dataset.id === 'string', cover && cover.dataset.id);
    cover.click(); await tick();
    ok('P0-1 点击书籍封面能打开详情', q1('#mask').classList.contains('on') &&
       q1('#sheet').textContent.indexOf('反脆弱') >= 0);

    const tb = q1('#sheet [data-act="togglebookstatus"]');
    tb.click(); await tick();
    ok('P0-1 标记为读完生效', S.books[0].status === 'done', S.books[0].status);

    let nBefore = window.LifeApp.activeNotes().length;
    q1('#sheet [data-act="delnote"]').click(); await tick();
    ok('P0-1 删除划线生效且内存同步', window.LifeApp.activeNotes().length === nBefore - 1,
       nBefore + ' -> ' + window.LifeApp.activeNotes().length);

    /* --- P1-5：重复导入去重 --- */
    goMe();
    q1('#view-me [data-act="import"]').click(); await tick();
    const ta = q1('#wr-text');
    ta.value = '反脆弱 - 塔勒布\n另一条划线。\n新的一条划线。\n新的一条划线。';
    nBefore = window.LifeApp.activeNotes().length;
    q1('#sheet [data-act="doimport"]').click(); await tick();
    const toastTxt = q1('#toast').textContent;
    ok('P1-5 重复导入只新增 1 条', window.LifeApp.activeNotes().length === nBefore + 1,
       nBefore + ' -> ' + window.LifeApp.activeNotes().length);
    ok('P1-5 重复条数被明确报告', /跳过 2 条重复/.test(toastTxt), toastTxt);

    /* --- P0-1 + P2-5：删书走自定义确认弹层 --- */
    goTab('library');
    q1('#view-library [data-act="openbook"]').click(); await tick();
    q1('#sheet [data-act="delbook"]').click(); await tick();
    ok('P2-5 自定义确认弹层出现且原生 confirm 未调用',
       q1('#confirm-mask').classList.contains('on') && !window.__nativeConfirmCalled,
       'native=' + (window.__nativeConfirmCalled || 0));
    ok('P0-1 删除书籍确认文案正确', /反脆弱/.test(q1('#a-msg').textContent), q1('#a-msg').textContent);
    q1('#a-cancel').click(); await tick();
    ok('P2-5 点取消后书籍仍在', window.LifeApp.activeBooks().length === 1);
    q1('#sheet [data-act="delbook"]').click(); await tick();
    q1('#a-ok').click(); await tick();
    ok('P0-1 确认后书籍与划线被软删除（行仍在库中）',
       window.LifeApp.activeBooks().length === 0 && window.LifeApp.activeNotes().length === 0 &&
       S.books.length === 1,
       'active=' + window.LifeApp.activeBooks().length + ' raw=' + S.books.length);

    const hist = dayAt(-3);
    const lvBefore = window.LifeApp.levelOf(hist);
    const entriesBefore = window.LifeApp.dayEntries(hist);
    const todayBefore = window.LifeApp.dayEntries(dayAt(0));
    const checkinsBefore = Object.keys(S.checkins[hist] || {}).length;

    goMe();
    q1('#view-me [data-act="delhabit"]').click(); await tick();
    ok('P0-1 删除习惯确认文案含名称', /删除「早起」/.test(q1('#a-msg').textContent), q1('#a-msg').textContent);
    q1('#a-ok').click(); await tick();
    ok('P0-1 习惯改为软删除', S.habits.length === 3 && S.habits.filter(h => h.archived).length === 1);
    ok('P0-2 历史热力等级不漂移', window.LifeApp.levelOf(hist) === lvBefore,
       lvBefore + ' -> ' + window.LifeApp.levelOf(hist));
    ok('P0-2 历史分母不随删项改写', window.LifeApp.dayEntries(hist) === entriesBefore,
       entriesBefore + ' -> ' + window.LifeApp.dayEntries(hist));
    ok('P0-2 历史打卡记录保留', Object.keys(S.checkins[hist] || {}).length === checkinsBefore);
    ok('P0-2 今日分母随删项减少', window.LifeApp.dayEntries(dayAt(0)) === todayBefore - 1,
       todayBefore + ' -> ' + window.LifeApp.dayEntries(dayAt(0)));
    S.habits.push({ id: 900, name: '临时', icon: 'sun', color: '#fff', target: '每天',
                    sort_order: 9, archived: false, created_at: new Date().toISOString() });
    ok('P0-2 新增习惯不改写历史分母', window.LifeApp.dayEntries(hist) === entriesBefore);
    S.habits.pop();

    /* --- P0-3 / P1-4：趋势页 --- */
    goTab('trend');
    const trendTxt = q1('#view-trend').textContent;
    ok('P0-3 趋势页无连击/连续字样', !/连续|连击/.test(trendTxt));
    ok('P0-3 指标卡剩 3 张', q1('#view-trend .mcell') &&
       document.querySelectorAll('#view-trend .mcell').length === 3);
    const days = [dayAt(-4), dayAt(-3), dayAt(-2), dayAt(-1), dayAt(0)];
    const pairs = window.LifeApp.corrPairs(days);
    ok('P1-4 睡眠对齐次日且缺失日剔除 (n=3)', pairs.n === 3, 'n=' + pairs.n);
    ok('P1-4 完成率取自次日快照',
       Math.abs(pairs.ys[0] - window.LifeApp.rateOfDay(dayAt(-3))) < 1e-9,
       String(pairs.ys[0]));
    ok('P1-4 趋势页保留三张指标卡与两张图表',
       document.querySelectorAll('#view-trend .mcell').length === 3 &&
       document.querySelectorAll('#view-trend .chartcard').length === 2 &&
       !/相关系数/.test(trendTxt));
    ok('P1-4 趋势页已去掉口径说明小字', !/断口表示当天没有数据/.test(trendTxt) &&
       !/共用同一纵轴/.test(trendTxt) && !/点按图表任意日期/.test(trendTxt));

    /* --- P1-5：连点「记一次」 --- */
    goTab('library');
    const logBtn = q1('#view-library [data-act="logstudy"]');
    logBtn.click(); logBtn.click();
    await tick();
    ok('P1-5 连点只产生 1 条学习记录', S.logs.length === 1 && store.study_logs.length === 1,
       'mem=' + S.logs.length + ' db=' + store.study_logs.length);
    ok('P1-5 按钮变成「今天已记」', !!q1('#view-library .pill[disabled]'));

    /* --- P1-6：COROS 固定 schema / 单位白名单 / 失败报警 --- */
    const C = window.Coros;
    let b = C.issueBucket();
    let m = C.mapItem('sleep', { date: hist, sleepDuration: 28800, sleepUnit: 's' }, 'get_sleep', b);
    ok('P1-6 固定 schema 正常映射', !!m && m.row.sleep_total === 8, m && JSON.stringify(m.row));

    b = C.issueBucket();
    m = C.mapItem('sleep', { date: hist, sleepDuration: 20 }, 'get_sleep', b);
    ok('P1-6 单位错配被区间拦截并报警', m === null && b.list().some(x => /超出合理区间/.test(x.reason)));

    b = C.issueBucket();
    m = C.mapItem('sleep', { date: hist, sleepDuration: 480, sleepUnit: 'furlong' }, 'get_sleep', b);
    ok('P1-6 白名单外单位报警', m === null && b.list().some(x => /不在白名单/.test(x.reason)));

    b = C.issueBucket();
    m = C.mapItem('sleep', { date: hist, duration: 3600 }, 'get_sleep', b);
    ok('P1-6 通用 duration 不串进睡眠', m === null && b.list().some(x => /没有匹配的字段/.test(x.reason)));

    b = C.issueBucket();
    m = C.mapItem('activity', { date: hist, duration: 1800, distance: 5.2, distanceUnit: 'km' }, 'get_activities', b);
    ok('P1-6 活动字段与距离单位白名单', !!m && m.row.duration_sec === 1800 && m.row.distance_m === 5200,
       m && JSON.stringify(m.row) + ' issues=' + b.list().length);

    /* --- COROS 文本报告解析（官方 MCP 实测格式，2026-11） --- */
    const ci = C.issueBucket();
    const dh = C.parseDailyHealth([
      'Daily Health Data — Last 7 days',
      '--- 20261102 ---',
      'Steps: 5,859 | Calories: 264 kcal | Exercise: 7 min',
      'Stress: Avg 33',
      'Sleep Summary:',
      '  Total: 7h 45min | Deep: 52 min | Light: 4h 53min | REM: 1h 51min | Awake: 9 min',
      '',
      '--- 20261108 ---',
      'Steps: 13,299 | Calories: 649 kcal',
      'Stress: Avg 58'
    ].join('\n'), ci);
    ok('COROS 文本：每日健康解析睡眠/步数/压力',
       dh.length === 2 && dh[0].row.sleep_total === 7.8 && dh[0].row.sleep_deep === 0.9 &&
       dh[0].row.steps === 5859 && dh[0].row.stress === 33 && dh[1].row.sleep_total === undefined,
       JSON.stringify(dh));
    ok('COROS 文本：HRV 只取评估段、不串入时间序列',
       C.parseHrv('HRV Assessment\n2026-11-06:\n  HRV Avg: 91 ms — Normal\n' +
                  'Sleep HRV Time Series\n2026-11-02:\n  hrv=124 ms').length === 1);
    ok('COROS 文本：静息心率跳过 No data',
       C.parseRestingHr('Resting Heart Rate\n2026-11-08: No data\n2026-11-06: 52 bpm').length === 1 &&
       C.parseRestingHr('Resting Heart Rate\n2026-11-08: No data\n2026-11-06: 52 bpm')[0].row.resting_hr === 52);
    ok('COROS 文本：压力与训练负荷按日期解析',
       C.parseStress('Stress Level\n2026-11-08:\nAverage Stress: 58')[0].row.stress === 58 &&
       C.parseLoad('Training Load\n2026-11-08\nComment: Optimized\nShort-Term Load: 45')[0].row.training_load === 45);
    const sp = C.parseSportRecords([
      'Sport Records — 2026-11-02 to 2026-11-08 (2 records)',
      '',
      '1. Indoor Run — 2026-11-08',
      '   Duration: 44:59 | Distance: 10.01 km',
      '   Avg HR: 173 bpm | Calories: 531 kcal',
      '   LabelId: 481605761542160886 | SportType: 101'
    ].join('\n'));
    ok('COROS 文本：运动记录时长/距离/去重键',
       sp.length === 1 && sp[0].duration_sec === 2699 && sp[0].distance_m === 10010 &&
       sp[0].avg_hr === 173 && sp[0].external_id === '481605761542160886', JSON.stringify(sp));
    const ov = C.parseSleepOverview('Sleep Overview\n\n2026-11-02\nDaily Sleep: 7h 36min (incl. naps)\n' +
      'Main Sleep (asleep): 7h 36min\nDeep Sleep Ratio: 11%\nREM Ratio: 24%');
    ok('COROS 文本：睡眠概览分期比例', ov.length === 1 && ov[0].row.sleep_deep === 0.8 &&
       ov[0].row.sleep_rem === 1.8, JSON.stringify(ov));
    ok('COROS 只读白名单排除写操作工具',
       Object.keys(C.READ_TOOLS).length === 7 &&
       Object.keys(C.READ_TOOLS).every(n => !/^(create|update|upload|schedule|delete|download)/i.test(n)) &&
       !C.READ_TOOLS.createScheduledWorkout && !C.READ_TOOLS.uploadRouteFile);
    ok('COROS 诊断接口可用', typeof C.diagnostics === 'function');

    /* --- P2-1 PWA manifest 与图标内联 --- */
    const mfLink = q1('link[rel=manifest]');
    let mf = null;
    try { if (mfLink) mf = await (await fetch(mfLink.href)).json(); } catch (e) {}
    ok('P2-1 manifest 图标走同源 URL（不再内联，首屏减重）',
       !!mf && mf.icons.length === 2 && mf.icons.every(i =>
         i.src.indexOf('/icon-') > 0 && i.src.indexOf('data:') !== 0),
       mf && mf.icons.map(i => i.src.slice(0, 46)).join('|'));
    const oldSc = localStorage.getItem('lb.sharecode');
    localStorage.setItem('lb.sharecode', 'TESTSC');
    ok('P2-1 图标 URL 带访问码，避免发布站点 403',
       /sharecode=TESTSC/.test(window.LifeApp.iconUrl(512)), window.LifeApp.iconUrl(512));
    if (oldSc === null) localStorage.removeItem('lb.sharecode'); else localStorage.setItem('lb.sharecode', oldSc);
    ok('P2-1 start_url 使用 appBase()', !!mf && mf.start_url === window.LifeApp.appBase(), mf && mf.start_url);
    ok('P2-1 构建号已注入', /^[0-9a-f]{10}$/.test(String(window.__LB_BUILD__ || '')), window.__LB_BUILD__);
    ok('P2-1 service worker 注册入口存在', typeof window.LifeApp.installSW === 'function');

    /* --- P2-5 5 tab + 设置入口 --- */
    ok('P2-5 阅读学习合并后底部标签为 4 个', document.querySelectorAll('#tabbar .tab').length === 4);
    q1('#btn-me').click(); await tick();
    ok('P2-5 右上角入口可进入「我的」', S.view === 'me' && !q1('#view-me').hidden);
    ok('P2-5 全站未调用原生 confirm', !window.__nativeConfirmCalled,
       'native=' + (window.__nativeConfirmCalled || 0));

    /* --- P2-2 骨架屏 / 离线快照 --- */
    window.LifeApp.renderSkeleton('today');
    ok('P2-2 骨架屏可渲染', !!q1('#view-today .sk-wrap'));
    window.LifeApp.render();
    window.LifeApp.saveSnapshot();
    const snap = window.LifeApp.readSnapshot();
    ok('P2-2 本地快照写入成功', !!snap && Array.isArray(snap.data.books) && snap.data.books.length >= 1);
    S.offline = true; window.LifeApp.render();
    ok('P2-2 离线条显示', !q1('#offline-bar').hidden);
    const habitsBeforeOffline = S.habits.length;
    q1('#view-me [data-act="delhabit"]').click(); await tick();
    ok('P2-2 离线时写操作被拦截', /离线只读/.test(q1('#toast').textContent) &&
       S.habits.length === habitsBeforeOffline && !!S.lastWriteError);
    S.offline = false; window.LifeApp.render();

    /* --- 写入可靠性：新建打卡项落库 / 匿名身份隔离 / 单表容错 / 诊断可见 --- */
    window.__MOCK__.forceOwner = null; window.__MOCK__.failTable = null;
    const hCount0 = store.habits.length;
    goTab('today'); await tick();
    const newHabitBtn = q1('[data-act="newhabit"]');
    if (newHabitBtn) newHabitBtn.click();
    await tick();
    const nameInput = q1('#ah-name');
    if (nameInput) { nameInput.value = '回归测试待办'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
    const saveHabitBtn = q1('[data-act="savehabit"]');
    if (saveHabitBtn) saveHabitBtn.click();
    await tick(); await tick();
    ok('写入：新建打卡项真实写入云端并留在内存',
       store.habits.length === hCount0 + 1 &&
       store.habits.some(h => h.name === '回归测试待办') &&
       S.habits.some(h => h.name === '回归测试待办'),
       'store=' + store.habits.length + ' S=' + S.habits.length);
    await window.LifeApp.loadAll();
    ok('写入：重新拉取云端数据后新项仍然存在',
       S.habits.some(h => h.name === '回归测试待办') && !S.offline);

    /* 云端把 INSERT 落到 owner_id='anon' 时必须报错，不能显示「已添加」 */
    window.__MOCK__.forceOwner = 'anon';
    const hCount1 = S.habits.length;
    const newHabitBtn2 = q1('[data-act="newhabit"]');
    if (newHabitBtn2) newHabitBtn2.click();
    await tick();
    const nameInput2 = q1('#ah-name');
    if (nameInput2) { nameInput2.value = '不该成功的待办'; nameInput2.dispatchEvent(new Event('input', { bubbles: true })); }
    const saveHabitBtn2 = q1('[data-act="savehabit"]');
    if (saveHabitBtn2) saveHabitBtn2.click();
    await tick(); await tick();
    ok('写入：匿名身份写入被拒绝并留下可诊断错误',
       /写入被云端隔离|重新登录/.test(q1('#toast').textContent) &&
       S.habits.length === hCount1 && !!S.lastWriteError,
       'toast=' + q1('#toast').textContent);
    const closeBtn = q1('[data-act="closesheet"]');
    if (closeBtn) closeBtn.click();
    window.__MOCK__.forceOwner = null;
    for (let i = store.habits.length - 1; i >= 0; i--) {
      if (store.habits[i].owner_id === 'anon') store.habits.splice(i, 1);
    }

    /* 插入成功、但按 id 回读不到时，也不能乐观地显示「已添加」 */
    const storeLen2 = store.habits.length, hCount2 = S.habits.length;
    window.__MOCK__.hideLastInserted = true;
    const newHabitBtn3 = q1('[data-act="newhabit"]');
    if (newHabitBtn3) newHabitBtn3.click();
    await tick();
    const nameInput3 = q1('#ah-name');
    if (nameInput3) { nameInput3.value = '读不回的待办'; nameInput3.dispatchEvent(new Event('input', { bubbles: true })); }
    const saveHabitBtn3 = q1('[data-act="savehabit"]');
    if (saveHabitBtn3) saveHabitBtn3.click();
    await tick(); await tick();
    ok('写入：写后回读失败时拒绝乐观更新',
       /无法读回/.test(q1('#toast').textContent) && S.habits.length === hCount2,
       'toast=' + q1('#toast').textContent);
    const closeBtn2 = q1('[data-act="closesheet"]');
    if (closeBtn2) closeBtn2.click();
    window.__MOCK__.hideLastInserted = false;
    store.habits.length = storeLen2;

    /* 单张表读取失败不应把整页打成离线只读 */
    window.__MOCK__.failTable = 'books';
    const booksBefore = S.books.length;
    let loadThrew = false;
    try { await window.LifeApp.loadAll(); } catch (e) { loadThrew = true; }
    ok('加载：单表失败不进入离线只读且保留缓存数据',
       !loadThrew && !S.offline && S.loadWarnings === 1 && S.books.length === booksBefore,
       'warnings=' + S.loadWarnings + ' books=' + S.books.length);
    /* 屏幕上这份是上次缓存时必须当场说明：以前只藏在「我的 → 数据健康」，
       用户会以为「刚删的又回来了」「刚加的丢了」 */
    window.LifeApp.render();
    const fbar = q1('#fresh-bar');
    ok('加载：部分表失败时顶部直接告警并可一键重新加载',
       !!fbar && !fbar.hidden && fbar.classList.contains('warn') &&
       /没读到/.test(fbar.textContent) && /上次缓存/.test(fbar.textContent) &&
       /书架/.test(fbar.textContent) && !!q1('#fresh-bar [data-act="reloadall"]'),
       'bar=' + (fbar ? fbar.textContent.trim() : 'null'));
    window.__MOCK__.failTable = null;

    /* --- 写入确认：云端返回 0 行（被 RLS 过滤）时绝不允许静默成功 --- */
    window.LifeApp.loadAll(); await tick();
    const hSnap = JSON.stringify(S.habits.find(h => String(h.id) === '1'));
    window.__MOCK__.dropUpdates = 'habits';
    let rmErr = null;
    try { await window.LifeApp.removeHabit(1); } catch (e) { rmErr = e; }
    const hSnap2 = JSON.stringify(S.habits.find(h => String(h.id) === '1'));
    ok('写入：云端 0 行确认时删除明确失败、且不改内存（不再「删了刷新又回来」）',
       !!rmErr && /0 行受影响/.test(rmErr.message) && hSnap === hSnap2,
       'err=' + (rmErr && rmErr.message) + ' changed=' + (hSnap !== hSnap2));
    /* 恢复云端确认后，同一个操作应当真正生效 */
    window.__MOCK__.dropUpdates = null;
    let rmOk = false;
    try { await window.LifeApp.removeHabit(1); rmOk = true; } catch (e) {}
    const hAfterRm = S.habits.find(h => String(h.id) === '1');
    ok('写入：恢复确认后删除真正落库并更新内存',
       rmOk && !!hAfterRm && hAfterRm.archived === true,
       'archived=' + (hAfterRm && hAfterRm.archived));
    delete window.__MOCK__.dropUpdates;

    /* 写操作后必须把本地快照一起更新：否则下次打开会先渲染旧快照，
       看起来就是「删了又回来 / 加了又没了」 */
    await sleep(1200);
    const snapNow = JSON.parse(localStorage.getItem('lb.snapshot.v1') || 'null');
    const snapHabit = snapNow && snapNow.data && snapNow.data.habits
      ? snapNow.data.habits.find(h => String(h.id) === '1') : null;
    ok('写入：操作后本地快照同步更新（重新打开不会先显示旧数据）',
       !!snapHabit && snapHabit.archived === true,
       'snap=' + (snapHabit ? snapHabit.archived : 'null'));

    goMe(); await tick();
    ok('诊断：我的页显示云端写入状态与数据账号',
       /云端写入/.test(q1('#view-me').textContent) && /数据账号/.test(q1('#view-me').textContent));

    /* --- P2-3 最近删除与恢复 --- */
    const trash = window.LifeApp.recentDeleted();
    ok('P2-3 最近删除列出软删除项', trash.length >= 3 && trash.some(x => x.kind === 'book'),
       trash.map(x => x.kind).join(','));
    q1('#view-me [data-act="trash"]').click(); await tick();
    const restoreBtn = q1('#sheet [data-act="restore"][data-kind="book"]');
    ok('P2-3 恢复入口存在', !!restoreBtn);
    if (restoreBtn) { restoreBtn.click(); await tick(); }
    ok('P2-3 恢复后书籍重新可见', window.LifeApp.activeBooks().length === 1,
       'books=' + window.LifeApp.activeBooks().length);

    /* --- P2-4 导出 / 导入备份 --- */
    localStorage.removeItem('lb.last_export'); window.LifeApp.render();
    ok('P2-4 从未导出时给出提醒', /还没有导出过备份/.test(q1('#view-me').textContent));
    const bak = await window.LifeApp.exportBackup();
    const parsedBak = JSON.parse(bak.json);
    ok('P2-4 导出含全部 9 张表且不含令牌',
       Object.keys(parsedBak.tables).length === 9 &&
       !(parsedBak.tables.app_kv || []).some(r => /^coros/i.test(String(r.k))),
       Object.keys(parsedBak.tables).length + ' tables');
    ok('P2-4 导出提醒时间戳已写入', !!localStorage.getItem('lb.last_export'));
    // 模拟云端丢了一条健康数据，用备份补回
    const lost = store.health_daily.splice(0, 1)[0];
    const r2 = await window.LifeApp.restoreBackup({
      app: 'life-dashboard', version: 1, tables: { health_daily: [lost] }
    });
    ok('P2-4 导入能补回缺失记录', r2.added === 1 && store.health_daily.length === 4,
       'added=' + r2.added + ' total=' + store.health_daily.length);
    let rejected = false;
    try { await window.LifeApp.restoreBackup({ foo: 1 }); } catch (e) { rejected = true; }
    ok('P2-4 非备份文件被拒绝', rejected);

    /* --- COROS 重复同步：复现真实 DB 把 date 列返回成 ISO 串 + 唯一约束 --- */
    const dupDay = dayAt(-1);
    store.health_daily.forEach(r => {
      if (String(r.day).length === 10) r.day = new Date(r.day + 'T00:00:00Z').toISOString();
    });
    // 清掉内存里的 id，强制走「回查数据库」路径（真实故障就发生在这一步）
    if (window.LifeApp.S.health[dupDay]) delete window.LifeApp.S.health[dupDay].id;
    // 基线：证明本 mock 确实复现了线上差异（旧写法 eq(day, ymd) 对 ISO 日期查不到行）
    const legacy = await window.WorkBuddyCloud.createWorkBuddyCloud().database
      .from('health_daily').select('id').eq('day', dupDay).limit(1);
    ok('回归基线：旧 eq(day) 在 ISO 日期下确实查不到',
       !(legacy && legacy.data && legacy.data.length), 'rows=' + ((legacy && legacy.data) || []).length);
    const beforeRows = store.health_daily.length;
    let dupErr = null;
    try {
      await window.LifeApp.upsertHealth(dupDay, { sleep_total: 7.8, hrv: 92, source: 'coros' });
      await window.LifeApp.upsertHealth(dupDay, { sleep_total: 8.1, hrv: 95, source: 'coros' });
    } catch (e) { dupErr = String((e && e.message) || e); }
    const hr = store.health_daily.find(r => String(r.day).slice(0, 10) === dupDay);
    ok('COROS 重复同步同一天不报唯一键冲突', dupErr === null, dupErr || '两次 upsert 均成功');
    ok('COROS 重复同步走 UPDATE 且不新增行',
       store.health_daily.length === beforeRows && hr && Number(hr.sleep_total) === 8.1,
       'rows=' + store.health_daily.length + ' sleep=' + (hr && hr.sleep_total));

    const freshDay = dayAt(-9);
    let freshErr = null;
    try { await window.LifeApp.upsertHealth(freshDay, { sleep_total: 7.2, source: 'coros' }); }
    catch (e) { freshErr = String((e && e.message) || e); }
    ok('COROS 新日期首次写入正常', freshErr === null &&
       store.health_daily.some(r => String(r.day).slice(0, 10) === freshDay), freshErr || '');

    const sport = { external_id: 'coros-test-1', day: dupDay, name: 'Indoor Run',
                    duration_sec: 2699, distance_m: 10010 };
    let actErr = null;
    try {
      await window.LifeApp.upsertActivity(sport);
      await window.LifeApp.upsertActivity(Object.assign({}, sport, { duration_sec: 2700 }));
    } catch (e) { actErr = String((e && e.message) || e); }
    const acts = store.activities.filter(r => String(r.external_id) === 'coros-test-1');
    ok('COROS 重复同步同一条运动不报唯一键冲突', actErr === null, actErr || '两次 upsert 均成功');
    ok('COROS 运动重复写入只保留 1 行且值更新',
       acts.length === 1 && Number(acts[0].duration_sec) === 2700,
       'rows=' + acts.length + ' dur=' + (acts[0] && acts[0].duration_sec));

    /* ==================== 本轮：运动类型图标 + P0/P1 优化 ==================== */
    const cssText = document.querySelector('style').textContent;

    /* --- 日历运动图标居中 --- */
    goTab('calendar'); await tick();
    const iconCell = q1('#view-calendar .cal-cell.hasact');
    ok('运动图标：日历格子内显示对应类型图标且水平居中',
       !!iconCell && !!iconCell.querySelector('.act-badge svg') &&
       getComputedStyle(iconCell).justifyContent === 'center' &&
       getComputedStyle(iconCell).alignItems === 'center',
       iconCell ? iconCell.className : 'none');
    ok('运动图标：类型映射覆盖骑行/游泳/力量/徒步',
       window.LifeApp.sportKind({ name: 'Indoor Cycling' }) === 'bike' &&
       window.LifeApp.sportKind({ name: 'Pool Swim' }) === 'swim' &&
       window.LifeApp.sportKind({ name: 'Strength' }) === 'strength' &&
       window.LifeApp.sportKind({ name: 'Hiking' }) === 'hike' &&
       window.LifeApp.sportKind({ name: 'Indoor Run' }) === 'run');
    const ac2 = q1('#view-calendar [data-act="calday"][data-id="' + dayAt(-1) + '"]');
    if (ac2) ac2.click(); await tick();
    ok('运动图标：明细行也用类型图标并带可读标签',
       !!q1('#view-calendar .actrow .licon svg') &&
       /室内跑步/.test(q1('#view-calendar .actrow .licon').getAttribute('aria-label')));
    ok('日历：格子带 aria-label 与 tabindex',
       !!q1('#view-calendar .cal-cell[aria-label][tabindex="0"]'));

    /* --- P0-6 日历导航 --- */
    ok('日历：有回到今天与年月跳转入口',
       !!q1('#view-calendar [data-act="caltoday"]') && !!q1('#view-calendar [data-act="caljump"]'));
    window.LifeApp.swipeMonth(-2); await tick();
    q1('#view-calendar [data-act="caltoday"]').click(); await tick();
    ok('日历：回今天恢复本月与选中日',
       S.calMonth.getMonth() === new Date().getMonth() && S.selDay === dayAt(0));
    q1('#view-calendar [data-act="caljump"]').click(); await tick();
    ok('日历：年月跳转面板可选年月', !!q1('#cj-year') && !!q1('#cj-month'));
    const lastY = new Date().getFullYear() - 1;
    q1('#cj-year').value = String(lastY); q1('#cj-month').value = '1';
    q1('#sheet [data-act="calgo"]').click(); await tick();
    ok('日历：可跳转到指定年月', S.calMonth.getFullYear() === lastY && S.calMonth.getMonth() === 0);
    const oldD = new Date(); oldD.setDate(oldD.getDate() - 410);
    S.calMonth = new Date(oldD.getFullYear(), oldD.getMonth(), 1); window.LifeApp.render(); await tick();
    ok('日历：超出 400 天数据范围的日期置灰并标注',
       !!q1('#view-calendar .cal-cell.nodata') &&
       /超出本地数据范围/.test(q1('#view-calendar .cal-cell.nodata').getAttribute('aria-label')));
    S.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    S.selDay = dayAt(0); window.LifeApp.render();

    /* --- P0-1/2/3 今日页 --- */
    goTab('today'); await tick();
    ok('P0-1：今日无身体数据时不再出现整块「还没同步」提示，改为四格下方就近同步',
       !q1('#view-today .insight') && !/还没同步到本机/.test(q1('#view-today').textContent) &&
       !!q1('#view-today [data-act="corosSync"]'));
    S.health[dayAt(0)] = { sleep_total: 7.2, hrv: 58, resting_hr: 54, training_load: 40 };
    window.LifeApp.render(); await tick();
    ok('P0-2：有今日身体数据时三格显示个人基线偏移',
       document.querySelectorAll('#view-today .hdelta').length >= 1 &&
       !!q1('#view-today [data-act="healthdetail"]') &&
       document.querySelectorAll('#view-today .hcell').length === 3);
    q1('#view-today [data-act="healthdetail"]').click(); await tick();
    ok('P0-2：点按展开近 14 天 sparkline 与基线值',
       !!q1('#health-spark svg.sparkline') && /个人基线/.test(q1('#health-spark').textContent));
    ok('P1-8：今日页有本周回顾折叠卡且含四项环比',
       !!q1('#view-today .review') && /上周/.test(q1('#view-today .review').textContent) &&
       document.querySelectorAll('#view-today .review .rv-row').length === 4);
    ok('P1-8b：今日页不再有洞察卡，也不再有训练负荷（含四格里的那一格）',
       !q1('#view-today .insight') && !q1('#view-today #week-review .insight') &&
       !/训练负荷/.test(q1('#view-today').textContent));
    const beforeProg = q1('#habit-prog') ? q1('#habit-prog').textContent : '';
    const habitRow = q1('#view-today .hchip[data-act="toggle"]');
    if (habitRow) habitRow.click(); await tick();
    ok('P0-3：打卡局部更新并带勾选动画，完成度小字同步',
       !!q1('#view-today .hchip.pop') && !!q1('#habit-prog') &&
       q1('#habit-prog').textContent !== beforeProg,
       beforeProg + ' -> ' + (q1('#habit-prog') ? q1('#habit-prog').textContent : ''));

    /* --- P0-3 撤销 --- */
    goTab('library'); await tick();
    q1('#view-library [data-act="openbook"]').click(); await tick();
    const noteBefore2 = window.LifeApp.activeNotes().length;
    q1('#sheet [data-act="delnote"]').click(); await tick();
    ok('P0-3：删除划线免确认、改为撤销 toast',
       !q1('#confirm-mask').classList.contains('on') &&
       !!q1('#toast .undo[data-act="undo"]') &&
       window.LifeApp.activeNotes().length === noteBefore2 - 1);
    q1('#toast .undo').click(); await tick();
    ok('P0-3：撤销可恢复划线', window.LifeApp.activeNotes().length === noteBefore2,
       String(noteBefore2));
    const delPlanBtn = q1('#view-library [data-act="delplan"]');
    if (delPlanBtn) { delPlanBtn.click(); await tick(); }
    ok('P0-3：删除计划同样免确认',
       !q1('#confirm-mask').classList.contains('on') && !!q1('#toast .undo'));
    if (q1('#toast .undo')) { q1('#toast .undo').click(); await tick(); }
    ok('P0-3：撤销后学习计划恢复', window.LifeApp.activePlans().length >= 1);

    /* --- P1-10 合并页分段 --- */
    ok('P1-10：合并页有粘性分段导航与双列容器',
       !!q1('#view-library .lib-nav') && !!q1('#view-library .lib-cols') &&
       !!q1('#lib-books') && !!q1('#lib-plans') && !!q1('#lib-logs'));
    ok('iOS 组件：分段控件初始就有选中滑块',
       q1('#view-library .lib-nav [data-id="lib-books"]').classList.contains('on'));
    q1('#view-library .lib-nav [data-id="lib-plans"]').click(); await tick();
    ok('P1-10：分段点击后高亮对应段',
       q1('#view-library .lib-nav [data-id="lib-plans"]').classList.contains('on'));

    /* --- P0-4/5 趋势页 --- */
    goTab('trend'); await tick();
    const gridCols = q1('#view-trend .metric') ? getComputedStyle(q1('#view-trend .metric')).gridTemplateColumns : '';
    ok('P0-4：指标卡统一三列并带环比与 sparkline',
       document.querySelectorAll('#view-trend .mcell').length === 3 &&
       gridCols.split(' ').length === 3 &&
       !!q1('#view-trend .mcell .cmp') && !!q1('#view-trend .mcell .spark svg'), gridCols);
    /* 图表类型现在是图卡的"标题"（嵌在 .chart-head 里的 seg），不再是独立一行 */
    const chartCard0 = q1('#view-trend .chartcard');
    ok('P0-5：图表默认单指标且末端标注当前值',
       !!q1('#view-trend .chartcard .chart-current') &&
       q1('#view-trend .chart-seg [data-id="rate"]').classList.contains('on') &&
       !!chartCard0.querySelector('.chart-head .chart-seg') &&
       /完成率/.test(chartCard0.textContent));
    q1('#view-trend .chart-seg [data-id="sleep"]').click(); await tick();
    ok('P0-5：可切换到睡眠单指标',
       q1('#view-trend .chart-seg [data-id="sleep"]').classList.contains('on') &&
       /睡眠/.test(q1('#view-trend .chartcard').textContent));
    q1('#view-trend .chart-seg [data-id="both"]').click(); await tick();
    ok('P0-5：可切换叠加视图',
       q1('#view-trend .chart-seg [data-id="both"]').classList.contains('on') &&
       /完成率/.test(q1('#view-trend .chartcard').textContent) &&
       /睡眠/.test(q1('#view-trend .chartcard').textContent));
    const hitEl = q1('#view-trend .chartwrap rect.hit[data-act="chartday"]');
    ok('P0-5：图表每个日期都有点击热区', !!hitEl && !!hitEl.getAttribute('data-id'));
    if (hitEl) {
      const targetDay = hitEl.getAttribute('data-id');
      hitEl.dispatchEvent(new MouseEvent('click', { bubbles: true })); await tick();
      ok('P0-5：点按图表跳到日历并选中该天',
         S.view === 'calendar' && S.selDay === targetDay, targetDay);
    }

    /* --- P1-7 相关性洞察 --- */
    goTab('trend'); await tick();
    const days5 = [dayAt(-4), dayAt(-3), dayAt(-2), dayAt(-1), dayAt(0)];
    const fList = window.LifeApp.factorInsights(days5);
    ok('P1-7：多因子相关性返回 6 个因子且按 |r| 排序',
       fList.length === 6 &&
       fList.every((x, i, a) => i === 0 || Math.abs(a[i - 1].r || 0) >= Math.abs(x.r || 0)));
    ok('趋势页：睡眠与次日完成率的关系模块已删除',
       !/睡眠与次日完成率的关系/.test(q1('#view-trend').textContent) &&
       !/相关系数 r/.test(q1('#view-trend').textContent) &&
       !/再积累 \d+ 天配对数据/.test(q1('#view-trend').textContent) &&
       !/多因子探索/.test(q1('#view-trend').textContent));

    /* --- P1-9 快速录入 --- */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await tick();
    ok('P1-9：Ctrl/⌘K 打开快速操作面板',
       q1('#mask').classList.contains('on') && !!q1('#quick-q') &&
       document.querySelectorAll('#quick-list .rowbtn').length >= 6);
    const qi = q1('#quick-q');
    if (qi) { qi.value = 'coros'; qi.dispatchEvent(new Event('input', { bubbles: true })); await tick(); }
    ok('P1-9：面板输入可过滤动作',
       Array.from(document.querySelectorAll('#quick-list .rowbtn')).filter(b => !b.hidden).length === 1);
    window.LifeApp.closeSheet();
    ok('P1-9：右上角有常驻快速入口', !!q1('#btn-quick[data-act="quick"]'));

    /* --- P1-11/12 可达性、状态透明 --- */
    ok('P1-11：焦点态 / 减少动画 / 40px 触控目标样式存在',
       /:focus-visible/.test(cssText) && /prefers-reduced-motion/.test(cssText) &&
       /\.iconbtn\{width:40px/.test(cssText));
    ok('P1-11：运动绿、进度蓝的颜色语义固定',
       /\.act-badge\{[^}]*var\(--green\)/.test(cssText) && /--heat-3/.test(cssText));
    ok('P1-12：同步 busy 样式与逻辑已抽取',
       /\[data-act="corosSync"\]\.busy/.test(cssText) &&
       typeof window.LifeApp.runCorosSync === 'function');
    goMe(); await tick();
    ok('P1-12：我的页有数据健康卡',
       !!q1('#data-health') && /近 7 天身体数据/.test(q1('#data-health').textContent) &&
       /COROS 连接/.test(q1('#data-health').textContent));
    const oldSnap = S.snapshotAt;
    S.snapshotAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    window.LifeApp.render(); await tick();
    ok('P1-12：数据陈旧时显示更新时间',
       !q1('#fresh-bar').hidden && /数据更新于 3 小时前/.test(q1('#fresh-bar').textContent));
    S.snapshotAt = oldSnap; window.LifeApp.render();

    /* ==================== iOS 液态玻璃 ==================== */
    ok('液态玻璃：默认开启且材质 token 已注入',
       document.documentElement.getAttribute('data-glass') === 'on' &&
       /--glass-fill/.test(cssText) && /--glass-content/.test(cssText) &&
       /backdrop-filter:blur\(var\(--glass-blur-strong\)\)/.test(cssText));

    const navEl = q1('.navbar');
    const contentEl = q1('#view-' + S.view + ' .card') || q1('.card');
    const navBf = navEl ? getComputedStyle(navEl).backdropFilter : '';
    const contentBf = contentEl ? getComputedStyle(contentEl).backdropFilter : '';
    ok('iOS 26：玻璃只在导航层，内容卡片改用系统材料不模糊',
       /blur/.test(navBf) && /^(none|)$/.test(contentBf),
       'nav=' + navBf + ' card=' + contentBf);
    const tabEl = q1('.tabbar');
    const tbRadius = tabEl ? parseFloat(getComputedStyle(tabEl).borderTopLeftRadius) : 0;
    const tbLeft = tabEl ? tabEl.getBoundingClientRect().left : 0;
    const tabBg = tabEl ? getComputedStyle(tabEl).backgroundColor : '';
    const navBg = navEl ? getComputedStyle(navEl).backgroundColor : '';
    ok('iOS 26：标签栏是浮动玻璃胶囊',
       tbRadius >= 20 && tbLeft >= 8 && /border-radius:999px/.test(cssText),
       'r=' + tbRadius + ' left=' + tbLeft);
    ok('iOS 26：组件覆盖未被 :is() 里的 ID 特异性压掉',
       /rgba\(26, 26, 32/.test(tabBg) && /rgba\(0, 0, 0, 0\)|transparent/.test(navBg),
       'tab=' + tabBg + ' nav=' + navBg);
    ok('顶栏：左侧标题与右侧设置项常显在同一行',
       /\.navbar h1\{font-size:17px;font-weight:600[^\n]*opacity:1/.test(cssText) &&
       /\.head h2\{display:none\}/.test(cssText) &&
       q1('#nav-title').textContent.length > 0 &&
       Math.abs(q1('#nav-title').getBoundingClientRect().top -
                q1('#btn-quick').getBoundingClientRect().top) < 30);
    ok('iOS 组件：胶囊分段与 inset grouped 缩进分隔线',
       /html\[data-glass="on"\] \.seg\{\s*border-radius:999px/.test(cssText) &&
       /\.card \.lrow:not\(:last-child\)/.test(cssText));

    ok('液态玻璃：环境光、镜面高光、光源跟随与减弱透明度降级齐全',
       /radial-gradient\(70% 52%/.test(cssText) && /--glass-hi/.test(cssText) &&
       /@property --gx/.test(cssText) && /prefers-reduced-transparency/.test(cssText) &&
       /@supports not/.test(cssText) && typeof window.LifeApp.initGlassLight === 'function');
    ok('液态玻璃：浅色主题有独立的玻璃材质参数',
       /:root\[data-theme="light"\]\{[^}]*--glass-fill:rgba\(255,255,255/.test(cssText));
    goMe(); await tick();
    const gsw = q1('#sw-glass[data-act="glass"]');
    ok('液态玻璃：我的页有可关闭的开关', !!gsw && gsw.classList.contains('on'));
    if (gsw) { gsw.click(); await tick(); }
    ok('液态玻璃：关闭后回退实色并写入偏好',
       document.documentElement.getAttribute('data-glass') === 'off' &&
       localStorage.getItem('lifeboard.glass') === 'off');
    const gsw2 = q1('#sw-glass[data-act="glass"]');
    if (gsw2) { gsw2.click(); await tick(); }
    ok('液态玻璃：可再次开启',
       document.documentElement.getAttribute('data-glass') === 'on' &&
       localStorage.getItem('lifeboard.glass') === 'on');
    goTab('today'); await tick();

    /* --- 今日打卡：一行胶囊清单 --- */
    const chips = document.querySelectorAll('#view-today .habit-strip .hchip:not(.add)');
    const strip = q1('#view-today .habit-strip');
    ok('今日页：首屏不再有完成度大卡片，第一块是今日状态（身体数据）',
       !q1('#view-today .hero') && !q1('#today-hero') &&
       q1('#view-today .health').getBoundingClientRect().top <
       q1('#view-today .habit-strip').getBoundingClientRect().top);
    ok('今日页：完成度收进打卡标题右侧的小字',
       !!q1('#habit-prog') && /^\d+\/\d+$/.test(q1('#habit-prog').textContent.trim()));
    ok('今日打卡：正常态是一行胶囊（含新建入口），不再是纵向列表',
       chips.length >= 1 && !!q1('#view-today .hchip.add') && !q1('#view-today .stripcard') &&
       strip.getBoundingClientRect().height < 44);
    /* 胶囊宽度跟着名字走（这正是它比四等分格子好看的原因），要求的是「同高、不换行」 */
    const ch = Array.prototype.map.call(chips, c => Math.round(c.getBoundingClientRect().height));
    const tops = Array.prototype.map.call(chips, c => Math.round(c.getBoundingClientRect().top));
    ok('今日打卡：胶囊同高、同一行内不换行，勾选框与名字内联排布',
       ch.length >= 2 && Math.max.apply(null, ch) - Math.min.apply(null, ch) <= 1 &&
       Math.max.apply(null, tops) - Math.min.apply(null, tops) <= 1 &&
       chips[0].querySelector('.hbox') && chips[0].querySelector('.hchip-t') &&
       chips[0].getBoundingClientRect().width > chips[0].querySelector('.hchip-t').getBoundingClientRect().width,
       'h=' + ch.join(',') + ' top=' + tops.join(','));
    const chip0 = chips[0];
    const boxBefore = chip0 ? chip0.querySelector('.hbox').style.background : '';
    if (chip0) { chip0.click(); await sleep(150); }
    const chipAfter = q1('#view-today .habit-strip .hchip');
    /* 勾选框状态要能即时翻转：完成＝实色底 + 白勾，未完成＝透明底 + 描边，与 .done 严格对应 */
    ok('今日打卡：点一下勾选框即时翻转（实色+白勾 ↔ 空心描边），无需刷新',
       !!chipAfter && chipAfter.querySelector('.hbox').style.background !== boxBefore &&
       (!!chipAfter.querySelector('.chk.on')) === chipAfter.classList.contains('done') &&
       (!chipAfter.classList.contains('done') || !!chipAfter.querySelector('.hbox .chk svg')) &&
       !chipAfter.querySelector('.licon'),
       'before=' + boxBefore + ' after=' + (chipAfter ? chipAfter.querySelector('.hbox').style.background : 'null'));
    if (chipAfter) { chipAfter.click(); await sleep(150); }
    q1('#view-today [data-act="edittoggle"]').click(); await tick();
    ok('今日打卡：编辑态回到纵向列表并露出删除按钮',
       !q1('#view-today .habit-strip') && !!q1('#view-today .card .lrow .minus'));
    q1('#view-today [data-act="edittoggle"]').click(); await tick();

    /* --- 本轮：今日提示 / 运动图标 / 微信读书 API 同步 --- */
    const savedTodayHealth = S.health[dayAt(0)];
    delete S.health[dayAt(0)];
    window.LifeApp.render(); await tick();
    const fbCell = q1('#view-today .health .hcell .v');
    const fbText = q1('#view-today').textContent.replace(/\s+/g, ' ');
    ok('今日：无当天数据时三格回落到最近一天并标注日期，而不是全空',
       !q1('#view-today .insight') &&
       !!q1('#view-today .health[data-day]') &&
       !!fbCell && !/^—/.test(fbCell.textContent.trim()) &&
       q1('#view-today .health').getAttribute('data-day') !== dayAt(0) &&
       /今天还没同步/.test(fbText) &&
       /月\s*\d+\s*日/.test(fbText) &&
       q1('#view-today [data-act="corosSync"]').textContent.indexOf('立即同步') >= 0,
       'cell=' + (fbCell ? fbCell.textContent : 'null') + ' | ' + fbText.slice(0, 120));

    /* 线上真实故障：COROS 会给「只有步数/压力」的那天也落一行，三格全空。
       以前把这种行当成「今天有数据」→ 三格全「—」且回落提示消失，
       用户看到的就是「同步完了还是没更新」。 */
    const hadCorosObj = Object.prototype.hasOwnProperty.call(window, 'Coros');
    const prevCorosObj = window.Coros;
    S.health[dayAt(0)] = { day: dayAt(0), steps: 8405, stress: 67, training_load: 25 };
    window.Coros = { status: function () { return { connected: true, lastSyncAt: new Date().toISOString(), lastSync: 'now', warnCount: 0 }; } };
    window.LifeApp.render(); await tick();
    const nullCell = q1('#view-today .health .hcell .v');
    const nullText = q1('#view-today').textContent.replace(/\s+/g, ' ');
    ok('今日：当天只有步数/压力时仍回落（不把三格刷成「—」），并说明已同步',
       !!q1('#view-today .health[data-day]') &&
       q1('#view-today .health').getAttribute('data-day') !== dayAt(0) &&
       !!nullCell && !/^—/.test(nullCell.textContent.trim()) &&
       /步数/.test(nullText) && /已同步/.test(nullText) && /上面是/.test(nullText) &&
       q1('#view-today [data-act="corosSync"]').textContent.indexOf('重新同步') >= 0,
       'cell=' + (nullCell ? nullCell.textContent : 'null') + ' | ' + nullText.slice(0, 140));
    if (hadCorosObj) window.Coros = prevCorosObj; else { try { delete window.Coros; } catch (e) { window.Coros = prevCorosObj; } }
    if (savedTodayHealth) S.health[dayAt(0)] = savedTodayHealth; else delete S.health[dayAt(0)];
    window.LifeApp.render();

    const runSvg = window.LifeApp.sportIcon({ name: 'Indoor Run' }, 14);
    const bikeSvg = window.LifeApp.sportIcon({ name: 'Cycling' }, 14);
    ok('运动图标：按类型映射为统一简洁一套（单路径 Material Symbols）',
       /viewBox="0 -960 960 960"/.test(runSvg) && /<path d="M/.test(runSvg) &&
       runSvg !== bikeSvg && (runSvg.match(/<path/g) || []).length === 1 &&
       !/stroke=/.test(runSvg) && /fill="currentColor"/.test(runSvg));

    ok('微信读书：官方 API 解析器与同步入口就绪',
       typeof window.Weread.parseShelf === 'function' &&
       typeof window.Weread.fetchShelf === 'function' &&
       typeof window.LifeApp.applyShelf === 'function' &&
       typeof window.Weread.GATEWAY === 'string' &&
       window.Weread.GATEWAY.indexOf('/api/agent/gateway') > 0);
    const shelf = window.Weread.parseShelf(JSON.stringify({
      books: [
        { bookInfo: { bookId: 'b1', title: '反脆弱', author: '塔勒布' }, progress: 35 },
        { bookInfo: { bookId: 'b2', title: '新书', author: '某人' }, progress: 100 },
        { bookInfo: { bookId: 'b1', title: '反脆弱', author: '塔勒布' }, progress: 35 }
      ]
    }));
    ok('微信读书：API 响应解析、bookId 去重与读完状态',
       shelf.length === 2 && shelf[0].title === '反脆弱' &&
       shelf[0].external_id === 'b1' && shelf[0].source === 'weread' &&
       shelf[1].status === 'done', JSON.stringify(shelf));
    window.LifeApp.openWereadSyncSheet(); await tick();
    ok('微信读书：同步面板含 Key 配置、API 同步与粘贴响应',
       !!q1('#wr-key') && !!q1('#sheet [data-act="doweresync"]') &&
       !!q1('#wr-shelf') && !!q1('#sheet [data-act="doshelfimport"]') &&
       /跨域|CORS/.test(q1('#sheet').textContent));
    window.LifeApp.closeSheet();
    const booksBeforeSync = window.LifeApp.activeBooks().length;
    await window.LifeApp.applyShelf([
      { title: 'API 同步的书', author: '作者', external_id: 'wx-1', status: 'reading', progress: 10, source: 'weread' }
    ]);
    ok('微信读书：API 书架写入云端并记录同步时间',
       window.LifeApp.activeBooks().length === booksBeforeSync + 1 &&
       !!window.LifeApp.S.wereadSyncAt &&
       window.LifeApp.S.books.some(b => b.title === 'API 同步的书' && b.source === 'weread'));

    /* --- 书架查重：DB 唯一索引兜底，前端要给人话而不是 SQL 报错 --- */
    const dupBefore = window.LifeApp.activeBooks().length;
    window.LifeApp.go('library'); await tick();
    window.LifeApp.openQuickSheet(); await tick();
    q1('[data-act="quickgo"][data-do="addbook"]').click(); await tick();
    q1('[data-act="manualbook"]').click(); await tick();
    q1('#mb-title').value = '  API 同步的书  ';      // 前后空格与大小写都要被归一化
    q1('#mb-title').dispatchEvent(new Event('input', { bubbles: true }));
    q1('[data-act="savemanualbook"]').click(); await sleep(120);
    ok('书架查重：同名书（含空格差异）不会新增，提示已在书架里',
       window.LifeApp.activeBooks().length === dupBefore &&
       /已经在书架里/.test(q1('#toast').textContent));
    window.LifeApp.closeSheet();
    /* ==================== 交互可达性 / 离线 / 安全 / 打磨 ==================== */
    goTab('today'); await tick();
    const ckRow = q1('#view-today .hchip[data-act="toggle"]');
    ok('交互：打卡行可聚焦且角色/状态可读',
       !!ckRow && ckRow.getAttribute('role') === 'checkbox' && ckRow.getAttribute('tabindex') === '0' &&
       /^(true|false)$/.test(ckRow.getAttribute('aria-checked') || ''),
       ckRow && (ckRow.getAttribute('role') + '/' + ckRow.getAttribute('aria-checked')));
    if (ckRow) {
      const a0 = ckRow.getAttribute('aria-checked');
      ckRow.focus();
      ckRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      const ckRow2 = q1('#view-today .hchip[data-act="toggle"]');
      ok('交互：Enter 键可打卡且 aria-checked 同步',
         !!ckRow2 && ckRow2.getAttribute('aria-checked') !== a0,
         a0 + ' -> ' + (ckRow2 && ckRow2.getAttribute('aria-checked')));
      if (ckRow2) { ckRow2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); }
    }
    const todayTxt = q1('#view-today').textContent;
    ok('交互：今日状态（身体数据）在打卡之前，完成度卡片已移除',
       todayTxt.indexOf('今日状态') > 0 &&
       todayTxt.indexOf('今日状态') < todayTxt.indexOf('睡眠') &&
       todayTxt.indexOf('睡眠') < todayTxt.indexOf('今日打卡') &&
       todayTxt.indexOf('今天还没开始') < 0,
       todayTxt.indexOf('今日状态') + '/' + todayTxt.indexOf('睡眠') + '/' + todayTxt.indexOf('今日打卡'));

    goTab('calendar'); await tick();
    const prev = q1('#view-calendar [data-act="calprev"]');
    if (prev) {
      prev.focus(); prev.click(); await tick();
      ok('交互：整页重绘后焦点回到原按钮',
         !!document.activeElement && document.activeElement.getAttribute('data-act') === 'calprev',
         document.activeElement && document.activeElement.getAttribute('data-act'));
    } else ok('交互：整页重绘后焦点回到原按钮', false, 'no calprev');

    ok('交互：顶栏入口改为同步，不再占用主题切换',
       !!q1('#btn-sync') && q1('#btn-sync').getAttribute('data-act') === 'corosSync' && !q1('#btn-theme'));
    window.LifeApp.renderSkeleton('trend');
    ok('交互：各标签页首进有骨架屏而非白屏',
       !!q1('#view-trend .sk-wrap') && !q1('#view-trend').hidden);
    window.LifeApp.render();

    /* --- 备份凭据过滤 --- */
    store.app_kv.push({ id: 9001, owner_id: 'u1', k: 'weread_api_key', v: { key: 'wrk-secret' } });
    store.app_kv.push({ id: 9002, owner_id: 'u1', k: 'coros_auth', v: { access_token: 'tok' } });
    store.app_kv.push({ id: 9003, owner_id: 'u1', k: 'theme', v: 'dark' });
    const bk = await window.LifeApp.fetchBackupRows();
    ok('安全：备份排除微信读书 Key 与 COROS 令牌，保留普通键',
       !(bk.tables.app_kv || []).some(r => /key|coros|token/i.test(String(r.k))) &&
       (bk.tables.app_kv || []).some(r => r.k === 'theme') &&
       bk.counts.app_kv === (bk.tables.app_kv || []).length,
       (bk.tables.app_kv || []).map(r => r.k).join(',') + ' counts=' + bk.counts.app_kv);

    /* --- 离线打卡队列 --- */
    goTab('today');
    S.offline = true; window.LifeApp.render(); await tick();
    const offRow = q1('#view-today .hchip[data-act="toggle"]');
    if (offRow) {
      offRow.click(); await tick();
      const pendN = Object.keys(S.pending || {}).length;
      ok('离线：打卡进入本机队列并标记待同步',
         pendN >= 1 && !!q1('#view-today .hchip.pending') &&
         /联网后自动同步/.test(q1('#toast').textContent) &&
         /待同步/.test(q1('#offline-bar').textContent),
         'pending=' + pendN + ' bar=' + q1('#offline-bar').textContent);
      S.offline = false;
      await window.LifeApp.refreshAll(); await tick();
      ok('离线：联网后队列回放并清空',
         Object.keys(S.pending || {}).length === 0 && !q1('#view-today .hchip.pending'),
         'left=' + Object.keys(S.pending || {}).length);
    } else ok('离线：打卡进入本机队列并标记待同步', false, 'no habit row');
    S.offline = false; localStorage.removeItem('lb.pendingCheckins.v1'); S.pending = {};

    /* --- 表单草稿 --- */
    goMe(); await tick();
    const addHabit = q1('#view-me [data-act="newhabit"]');
    if (addHabit) {
      addHabit.click(); await tick();
      const inp = q1('#ah-name');
      inp.value = '草稿测试项';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      window.LifeApp.closeSheet(); await tick();
      q1('#view-me [data-act="newhabit"]').click(); await tick();
      ok('打磨：关闭表单后草稿不丢',
         !!q1('#ah-name') && q1('#ah-name').value === '草稿测试项',
         q1('#ah-name') && q1('#ah-name').value);
      window.LifeApp.closeSheet();
      window.LifeApp.draftClear('habit');
    } else ok('打磨：关闭表单后草稿不丢', false, 'no newhabit');

    /* --- 微信读书面板主路径 --- */
    q1('#view-me [data-act="wereadsync"]').click(); await tick();
    const primary = q1('#sheet .btnblock.blue');
    ok('交互：微信读书主路径是粘贴同步，直连收进高级区',
       !!primary && /解析并同步书架/.test(primary.textContent) &&
       !!q1('#sheet details.adv') && !!q1('#sheet details.adv [data-act="doweresync"]'));
    window.LifeApp.closeSheet();

    /* --- 连续删除可逐条撤销 --- */
    goTab('library'); await tick();
    const anyBook = window.LifeApp.activeBooks()[0];
    if (anyBook) { window.LifeApp.openBook(anyBook.id); await tick(); }
    const n0 = window.LifeApp.activeNotes().length;
    let del = q1('#sheet [data-act="delnote"]');
    if (del && n0 >= 2) {
      del.click(); await tick();
      del = q1('#sheet [data-act="delnote"]');
      if (del) { del.click(); await tick(); }
      const undos = document.querySelectorAll('#toast .undo');
      if (undos.length) undos[0].click(); await tick();
      const u2 = q1('#toast .undo');
      if (u2) u2.click(); await tick();
      ok('打磨：连续删除可逐条撤销',
         window.LifeApp.activeNotes().length === n0,
         n0 + ' -> ' + window.LifeApp.activeNotes().length);
    } else ok('打磨：连续删除可逐条撤销', false, 'notes=' + n0);
    window.LifeApp.closeSheet();

    /* --- 账号隔离：快照/离线队列不跨账号 --- */
    localStorage.setItem('lb.pendingCheckins.v1', JSON.stringify({ '2026-01-01|999': true }));
    localStorage.setItem('lb.snapshot.v1', JSON.stringify({
      at: new Date().toISOString(), owner: 'other-user',
      data: { habits: [{ id: 1, name: '别人的习惯' }], checkins: {}, health: {}, activities: [], books: [], notes: [], plans: [], logs: [] }
    }));
    localStorage.setItem('lb.draft.habit', JSON.stringify({ at: Date.now(), v: { 'ah-name': '别人的草稿' } }));
    const foreignSnap = window.LifeApp.readSnapshot();
    const mismatch = window.LifeApp.snapshotOfOtherUser();
    window.LifeApp.clearLocalData();
    ok('安全：快照按账号隔离，换账号不读他人缓存',
       foreignSnap === null && mismatch === true &&
       !localStorage.getItem('lb.snapshot.v1') &&
       !localStorage.getItem('lb.pendingCheckins.v1') &&
       !localStorage.getItem('lb.draft.habit') &&
       Object.keys(S.pending || {}).length === 0,
       'mismatch=' + mismatch + ' snap=' + (foreignSnap === null));

    /* --- 备份分页：超过单页也要取全 --- */
    const notesBefore = store.notes.length;
    for (let i = 0; i < 1200; i++) {
      store.notes.push({ id: 50000 + i, owner_id: 'u1', book_id: 11, chapter: '', content: '分页测试划线 ' + i,
        created_at: '2024-01-01T00:00:00Z' });
    }
    const bigBk = await window.LifeApp.fetchBackupRows();
    ok('数据：备份分页取全（1200 行 > 单页 500）',
       bigBk.counts.notes === notesBefore + 1200 && bigBk.tables.notes.length === notesBefore + 1200 &&
       bigBk.truncated.length === 0,
       'notes=' + bigBk.counts.notes + ' truncated=' + bigBk.truncated.join(','));
    store.notes.splice(notesBefore, 1200);

    /* --- 运动记录触达上限要有明示 --- */
    const actsBefore = store.activities.length;
    for (let i = 0; i < 210; i++) {
      store.activities.push({ id: 60000 + i, owner_id: 'u1', external_id: 'cap-' + i, day: window.__dayAt__(-1),
        type: '101', name: 'Indoor Run', duration_sec: 1800, distance_m: '5000.0', avg_hr: 150, calories: 300 });
    }
    await window.LifeApp.loadAll(); goTab('calendar'); await tick();
    const capTxt = q1('#view-calendar').textContent;
    ok('数据：运动触达上限时日历明确提示，不静默少显示',
       S.limits.activities === true && /仅按最近 200 条运动统计/.test(capTxt),
       'limit=' + S.limits.activities);
    store.activities.splice(actsBefore, 210);
    await window.LifeApp.loadAll(); goTab('today'); await tick();

    /* --- 每天首次打开自动同步 COROS --- */
    const realCoros = window.Coros;
    let syncCalls = 0;
    window.Coros = {
      status: () => ({ connected: true }),
      sync: async () => { syncCalls++; return { days: 2, activities: 1, warnings: [] }; }
    };
    localStorage.removeItem('lb.corosAutoDay');
    const sync1 = await window.LifeApp.syncCorosDaily({ silent: true });
    const marked = window.LifeApp.corosAutoDoneToday();
    const sync2 = await window.LifeApp.syncCorosDaily({ silent: true });
    ok('COROS：每天首次打开自动同步一次，成功后写标记且当天不重复',
       sync1.ok === true && syncCalls === 1 && marked === true && sync2.skipped === true,
       'ok=' + sync1.ok + ' calls=' + syncCalls + ' marked=' + marked + ' again=' + sync2.skipped);

    let failCalls = 0;
    window.Coros = {
      status: () => ({ connected: true }),
      sync: async () => { failCalls++; throw new Error('boom'); }
    };
    localStorage.removeItem('lb.corosAutoDay');
    const syncFail = await window.LifeApp.syncCorosDaily({ silent: true });
    ok('COROS：自动同步失败不写标记，下次打开会重试',
       syncFail.ok === false && failCalls === 1 && !window.LifeApp.corosAutoDoneToday(),
       'ok=' + syncFail.ok + ' marked=' + window.LifeApp.corosAutoDoneToday());
    window.Coros = realCoros;
    localStorage.removeItem('lb.corosAutoDay');

    /* --- 确认弹层：Esc 取消 + 焦点留在弹层内 --- */
    let confirmVal = null;
    const cp = window.LifeApp.askConfirm({ title: '删除', message: '测试' });
    cp.then(v => { confirmVal = v; });
    await new Promise(r => setTimeout(r, 80));
    const cMask = q1('#confirm-mask');
    const focusInside = !!(document.activeElement && cMask.contains(document.activeElement));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    ok('交互：确认弹层支持 Esc 取消且焦点不落到背景',
       confirmVal === false && focusInside && !cMask.classList.contains('on'),
       'val=' + confirmVal + ' focusInside=' + focusInside);

    /* --- 读屏播报 --- */
    ok('交互：toast 有 role=status 与 aria-live，保存结果可被读屏播报',
       q1('#toast').getAttribute('role') === 'status' &&
       q1('#toast').getAttribute('aria-live') === 'polite');

    /* --- 登录态持久化：会话镜像与复原 --- */
    const SKEY = 'workbuddy-cloud.session.' + window.APP_CONFIG.cloud.publishableKey;
    const keepRaw = localStorage.getItem(SKEY);
    localStorage.setItem(SKEY, JSON.stringify({
      accessToken: 'a'.repeat(80), refreshToken: 'r'.repeat(24),
      expiresAt: Date.now() + 3600e3, user: { id: 'u1', name: '测试', raw: { note: 'x' } }
    }));
    ok('登录态：会话可写入持久化 cookie（file:// 禁 cookie，只验不抛错且本地会话保留）',
       window.LifeApp.persistSession() === true && !!localStorage.getItem(SKEY));
    ok('登录态：本地已有会话时 restore 不覆盖、只续期',
       window.LifeApp.restoreSession() === false && !!localStorage.getItem(SKEY));
    localStorage.removeItem(SKEY);
    let restoreOk = false, restoredBack = 'x';
    try { restoreOk = window.LifeApp.restoreSession() === false; restoredBack = localStorage.getItem(SKEY); }
    catch (e) { restoreOk = false; }
    ok('登录态：本地会话被清后 restore 不报错且不伪造会话',
       restoreOk && restoredBack === null);

    /* --- 书架吸顶工具条：只有真被顶住时才上材质 --- */
    goTab('library'); await tick();
    window.scrollTo(0, 420); await tick();
    window.LifeApp.syncStickyBars();
    ok('交互：书架吸顶工具条滚动后才上材质', !!q1('.lib-nav') && q1('.lib-nav').classList.contains('stuck'));
    window.scrollTo(0, 0); await tick();
    window.LifeApp.syncStickyBars();
    ok('交互：回到顶部时工具条恢复透明（不留灰带）',
       !!q1('.lib-nav') && !q1('.lib-nav').classList.contains('stuck'));
    if (keepRaw) localStorage.setItem(SKEY, keepRaw); else localStorage.removeItem(SKEY);

    /* --- 每日 COROS 同步：标记语义（0 天不能把当天锁死） --- */
    const savedCoros = window.Coros;
    const AUTO_KEY = 'lb.corosAutoDay';
    try {
      window.Coros = {
        afterLogin: async function () {},
        status: function () { return { connected: true }; },
        sync: async function () { return { days: 0, activities: 0, warnings: [] }; }
      };
      localStorage.removeItem(AUTO_KEY);
      const r0 = await window.LifeApp.syncCorosDaily({ silent: true, force: true });
      ok('自动同步：0 天结果不写「今天已完成」，当天仍可再试（不再把空结果锁一整天）',
         r0 && r0.ok === true && localStorage.getItem(AUTO_KEY) !== dayAt(0));
      window.Coros.sync = async function () { return { days: 1, activities: 0, warnings: [] }; };
      await window.LifeApp.syncCorosDaily({ silent: true, force: true });
      ok('自动同步：确实拿到数据后才写当天标记，避免重复拉取',
         localStorage.getItem(AUTO_KEY) === dayAt(0));
    } finally {
      window.Coros = savedCoros;
      localStorage.removeItem(AUTO_KEY);
    }
  } catch (e) {
    out.push('FAIL | 测试脚本异常 | ' + (e && e.message) + ' @ ' + (e && e.stack || '').split('\n')[1]);
  }

  const passed = out.filter(x => x.indexOf('PASS') === 0).length;
  const body = out.join('\n') + '\nSUMMARY ' + passed + '/' + out.length;
  // 截图前先收起测试过程中残留的 sheet
  window.LifeApp.closeSheet();
  // 带 #trend 打开时停在趋势页，便于单独截图复核视觉
  if (location.hash.indexOf('trend') >= 0) goTab('trend');
  if (location.hash.indexOf('library') >= 0) goTab('library');
  if (location.hash.indexOf('calendar') >= 0) {
    S.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    S.selDay = dayAt(-1);
    S.view = 'calendar';
    window.LifeApp.render();
  }
  if (location.hash.indexOf('confirm') >= 0) {
    window.LifeApp.askConfirm({ title: '删除这本书',
      message: '「反脆弱」及其划线会移入「最近删除」，可随时恢复。', okText: '删除' });
  }
  const pre = document.createElement('pre');
  pre.id = 'test-out';
  pre.textContent = body;
  pre.style.display = 'none';
  document.body.appendChild(pre);
})();
'''


def main():
    if not os.path.exists(SRC):
        print('缺少 index.html，请先运行 python3 build.py')
        return 1
    with open(SRC, encoding='utf-8') as f:
        page = f.read()

    marker = '<!--__LB_APP__-->'
    if marker not in page:
        print('未找到 app.js 注入点，检查 build.py 产物')
        return 1
    page = page.replace(marker, '<script>\n' + MOCK + '\n</script>\n' + marker, 1)
    page = page.replace('</body>', '<script>\n' + TEST + '\n</script>\n</body>', 1)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(page)

    cmd = [CHROME, '--headless=new', '--disable-gpu', '--no-sandbox',
           '--disable-dev-shm-usage', '--virtual-time-budget=15000',
           '--dump-dom', 'file://' + OUT]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    dom = p.stdout
    # 结果放在专门的 <pre> 里；不能用字符串标记搜索，因为 <script> 源码也会出现在 dump-dom 中
    m = re.search(r'<pre id="test-out"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        print('未能读回测试结果（Chrome 退出码 %s）' % p.returncode)
        print((p.stderr or '')[-1200:])
        print(dom[-800:])
        return 1
    result = htmlmod.unescape(m.group(1)).strip()
    tail = re.search(r'SUMMARY (\d+)/(\d+)', result)
    print(result)
    print('---')
    fails = [x for x in result.splitlines() if x.startswith('FAIL')]
    if fails or not tail or tail.group(1) != tail.group(2):
        print('存在 %d 项失败' % len(fails))
        return 1
    print('全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
