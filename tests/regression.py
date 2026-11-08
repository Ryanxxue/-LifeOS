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
    activities: [],
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
    const list = store[t] || (store[t] = []);
    const match = row => query.filters.every(f => {
      const rv = row[f[0]];
      if (f[1] === 'eq') {
        if (f[2] === null) return rv === null || rv === undefined;
        return String(rv) === String(f[2]);
      }
      if (f[1] === 'gte') return String(rv) >= String(f[2]);
      return true;
    });
    if (query.op === 'select') {
      let rows = list.filter(match).map(clone);
      if (query.lim) rows = rows.slice(0, query.lim);
      return rows;
    }
    if (query.op === 'insert') {
      const out = [];
      for (const p of query.payload) {
        const r = Object.assign({}, p);
        r.id = ++seq;
        r.owner_id = 'u1';
        r.created_at = r.created_at || new Date().toISOString();
        if (t === 'study_logs' && store[t].some(x => String(x.plan_id) === String(r.plan_id) && x.day === r.day)) {
          throw new Error('duplicate key value violates unique constraint 23505 study_logs_dedupe_idx');
        }
        if (t === 'notes' && store[t].some(x => String(x.book_id) === String(r.book_id) && x.content === r.content)) {
          throw new Error('duplicate key value violates unique constraint 23505 notes_dedupe_idx');
        }
        store[t].push(r);
        out.push(clone(r));
      }
      return out;
    }
    if (query.op === 'update') {
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
    constructor(t) { this.t = t; this.op = 'select'; this.filters = []; this.payload = null; this.lim = 0; }
    select() { return this; }
    order() { return this; }
    gte(k, v) { this.filters.push([k, 'gte', v]); return this; }
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
    ok('P0-1 状态主键已归一化为字符串', typeof S.books[0].id === 'string' && typeof S.habits[0].id === 'string',
       'book=' + typeof S.books[0].id + ' habit=' + typeof S.habits[0].id);

    /* --- P0-1：全部走真实 DOM 点击 --- */
    goTab('reading');
    const cover = q1('#view-reading [data-act="openbook"]');
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
    goTab('reading');
    q1('#view-reading [data-act="openbook"]').click(); await tick();
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
    ok('P1-4 趋势页标注样本量 n 与 p', /n=3/.test(trendTxt) && /p=/.test(trendTxt));
    ok('P1-4 小样本不给强结论', /样本偏少/.test(trendTxt));

    /* --- P1-5：连点「记一次」 --- */
    goTab('study');
    const logBtn = q1('#view-study [data-act="logstudy"]');
    logBtn.click(); logBtn.click();
    await tick();
    ok('P1-5 连点只产生 1 条学习记录', S.logs.length === 1 && store.study_logs.length === 1,
       'mem=' + S.logs.length + ' db=' + store.study_logs.length);
    ok('P1-5 按钮变成「今天已记」', !!q1('#view-study .pill[disabled]'));

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

    /* --- P2-1 PWA manifest 与图标内联 --- */
    const mfLink = q1('link[rel=manifest]');
    let mf = null;
    try { if (mfLink) mf = await (await fetch(mfLink.href)).json(); } catch (e) {}
    ok('P2-1 manifest 图标全部内联为 data URI',
       !!mf && mf.icons.length === 2 && mf.icons.every(i => i.src.indexOf('data:image/png;base64,') === 0),
       mf && mf.icons.length);
    ok('P2-1 start_url 使用 appBase()', !!mf && mf.start_url === window.LifeApp.appBase(), mf && mf.start_url);
    ok('P2-1 构建号已注入', /^[0-9a-f]{10}$/.test(String(window.__LB_BUILD__ || '')), window.__LB_BUILD__);
    ok('P2-1 service worker 注册入口存在', typeof window.LifeApp.installSW === 'function');

    /* --- P2-5 5 tab + 设置入口 --- */
    ok('P2-5 底部标签精简为 5 个', document.querySelectorAll('#tabbar .tab').length === 5);
    q1('#btn-me').click(); await tick();
    ok('P2-5 右上角入口可进入「我的」', S.view === 'me' && !q1('#view-me').hidden);
    ok('P2-5 全站未调用原生 confirm', !window.__nativeConfirmCalled,
       'native=' + (window.__nativeConfirmCalled || 0));

    /* --- P2-2 骨架屏 / 离线快照 --- */
    window.LifeApp.renderSkeleton();
    ok('P2-2 骨架屏可渲染', !!q1('#view-today .sk-wrap'));
    window.LifeApp.render();
    window.LifeApp.saveSnapshot();
    const snap = window.LifeApp.readSnapshot();
    ok('P2-2 本地快照写入成功', !!snap && Array.isArray(snap.data.books) && snap.data.books.length >= 1);
    S.offline = true; window.LifeApp.render();
    ok('P2-2 离线条显示', !q1('#offline-bar').hidden);
    const habitsBeforeOffline = S.habits.length;
    q1('#view-me [data-act="delhabit"]').click(); await tick();
    ok('P2-2 离线时写操作被拦截', /离线中/.test(q1('#toast').textContent) &&
       S.habits.length === habitsBeforeOffline);
    S.offline = false; window.LifeApp.render();

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
  } catch (e) {
    out.push('FAIL | 测试脚本异常 | ' + (e && e.message) + ' @ ' + (e && e.stack || '').split('\n')[1]);
  }

  const passed = out.filter(x => x.indexOf('PASS') === 0).length;
  const body = out.join('\n') + '\nSUMMARY ' + passed + '/' + out.length;
  // 截图前先收起测试过程中残留的 sheet
  window.LifeApp.closeSheet();
  // 带 #trend 打开时停在趋势页，便于单独截图复核视觉
  if (location.hash.indexOf('trend') >= 0) goTab('trend');
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

    marker = "<script>\n(function () {\n'use strict';\n\n/* ==================== 工具 ==================== */"
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
