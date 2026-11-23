#!/usr/bin/env python3
"""线上写入探测：以真实登录用户的身份，逐表验证「写得进、读得回、改得动」。

和 anon_probe.py 是互补的两面：那个验证未登录写不进去，这个验证登录后全都写得进去。
覆盖 9 张表，每张表走一遍 INSERT → SELECT 回读 → PATCH → DELETE，
并按 app.js 的判据校验 owner_id（不能是 'anon'，且 9 张表必须是同一个 owner），
因为历史上出过「云端以 owner_id='anon' 成功写入，随后 SELECT 被 RLS 过滤，
表现为已添加、刷新就没了」的问题——只看 INSERT 返回 201 会漏掉它。

用法（三步，验证码要人工收）：
    python3 tests/write_probe.py --email you@example.com    # 发验证码
    python3 tests/write_probe.py --code 123456              # 换 JWT 并跑全部探测
    python3 tests/write_probe.py                            # 复用缓存 JWT 再跑一次
    python3 tests/write_probe.py --keep                     # 保留探针数据，便于到界面上肉眼确认

退出码：0 全部通过；1 有任一项失败（真问题）；2 未登录或网络不可达（探测没做完）。
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, 'config.js')
STATE = os.path.join(HERE, '.probe_state.json')   # 含 JWT，已在 .gitignore 里

MARK = '__WRITE_PROBE__'


def load_config():
    with open(CONFIG, encoding='utf-8') as f:
        cfg = f.read()
    endpoint = re.search(r'endpoint:\s*"([^"]+)"', cfg)
    key = re.search(r'publishableKey:\s*"([^"]+)"', cfg)
    if not endpoint or not key:
        raise SystemExit('无法从 config.js 解析 endpoint / publishableKey')
    return endpoint.group(1).rstrip('/'), key.group(1)


class Api:
    def __init__(self, endpoint, key, token=None):
        self.endpoint = endpoint
        self.key = key
        self.token = token

    def call(self, path, method='GET', body=None, prefer=None, timeout=25):
        url = self.endpoint + path
        data = None
        headers = {
            'x-wb-webapp-access-key': self.key,
            # 网关会看来源：同样的 Bearer 令牌，不带 Origin 直接 401
            # （"issued for another client"），带上就是 200。浏览器里天然有这一头，
            # 脚本里必须自己补，否则探针会把「令牌有效」误判成「登录失效」。
            'Origin': self.endpoint,
            'Referer': self.endpoint + '/',
            'Accept': '*/*',
        }
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if prefer:
            headers['Prefer'] = prefer
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw)
            except Exception:
                payload = raw.decode('utf-8', 'replace')
            return e.code, payload
        except Exception as e:
            raise SystemExit('网络不可达：%s（endpoint=%s）' % (e, self.endpoint))

    # --- 数据库 ---
    # 过滤条件只能写 column=op.value（如 id=eq.5）。写成 PostgREST 标准的
    # column.op.value（如 name.eq.x）不会被报错，而是**静默忽略并返回全表**：
    # 于是回读校验会看到「行数不对」以外的假结果，残留检查会永远得到 0。
    def db(self, table, query='', method='GET', body=None, prefer=None):
        path = '/.cloud/database/rest/' + table + (('?' + query) if query else '')
        return self.call(path, method=method, body=body, prefer=prefer)


def jwt_sub(token):
    """从 JWT payload 里取 sub，仅用于和 owner_id 对照，不做验签。"""
    try:
        part = token.split('.')[1]
        part += '=' * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part)).get('sub') or ''
    except Exception:
        return ''


def save_state(**kw):
    st = {}
    if os.path.exists(STATE):
        try:
            with open(STATE, encoding='utf-8') as f:
                st = json.load(f)
        except Exception:
            st = {}
    st.update(kw)
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=2)


def load_state():
    if not os.path.exists(STATE):
        return {}
    with open(STATE, encoding='utf-8') as f:
        return json.load(f)


def send_code(api, email):
    st, payload = api.call('/.cloud/auth/v1/verification', method='POST',
                           body={'email': email, 'usage': 'email'})
    if st >= 300 or not isinstance(payload, dict) or not payload.get('verification_id'):
        raise SystemExit('发送验证码失败（HTTP %s）：%s' % (st, payload))
    save_state(email=email, verification_id=payload['verification_id'],
               is_existing_user=payload.get('is_user'), issued_at=int(time.time()))
    print('验证码已发送到 %s（is_user=%s）' % (email, payload.get('is_user')))
    if payload.get('is_user') is False:
        print('注意：该邮箱在云端还不是已有用户，需先在 App 里完整登录一次，'
              '本脚本才能用验证码换到会话。')
    print('收件箱取 6 位码后运行：python3 tests/write_probe.py --code <码>')


def login(api, code):
    st = load_state()
    if not st.get('verification_id'):
        raise SystemExit('没有待验证的邮箱，先运行 --email <邮箱>')
    status, payload = api.call('/.cloud/auth/v1/verification/verify', method='POST',
                               body={'verification_id': st['verification_id'],
                                     'verification_code': code})
    if status >= 300 or not isinstance(payload, dict) or not payload.get('verification_token'):
        raise SystemExit('验证码校验失败（HTTP %s）：%s' % (status, payload))
    status, sess = api.call('/.cloud/auth/v1/signin', method='POST',
                            body={'username': st['email'],
                                  'verification_token': payload['verification_token']})
    if status >= 300 or not isinstance(sess, dict) or not sess.get('access_token'):
        raise SystemExit('换取会话失败（HTTP %s）：%s' % (status, sess))
    save_state(access_token=sess['access_token'],
               refresh_token=sess.get('refresh_token', ''),
               expires_at=int(time.time() * 1000) + int(sess.get('expires_in') or 0) * 1000,
               sub=sess.get('sub') or '')
    api.token = sess['access_token']
    print('已登录：sub=%s' % (sess.get('sub') or jwt_sub(api.token) or '(未知)'))


def refresh(api):
    st = load_state()
    rt = st.get('refresh_token')
    if not rt:
        return False
    status, sess = api.call('/.cloud/auth/v1/token', method='POST',
                            body={'grant_type': 'refresh_token', 'refresh_token': rt})
    if status >= 300 or not isinstance(sess, dict) or not sess.get('access_token'):
        return False
    save_state(access_token=sess['access_token'],
               refresh_token=sess.get('refresh_token', rt),
               expires_at=int(time.time() * 1000) + int(sess.get('expires_in') or 0) * 1000)
    api.token = sess['access_token']
    return True


def insert(api, table, body):
    status, payload = api.db(table, 'select=*', 'POST', body, prefer='return=representation')
    if status >= 300:
        return None, 'HTTP %s %s' % (status, err_text(payload))
    if not isinstance(payload, list) or not payload:
        return None, '返回体为空（status=%s）' % status
    return payload[0], None


def err_text(payload):
    if isinstance(payload, dict):
        for k in ('message', 'error_description', 'hint', 'details', 'code'):
            if payload.get(k):
                return str(payload[k])
        return json.dumps(payload, ensure_ascii=False)[:200]
    return str(payload)[:200]


def run(api, keep):
    st = load_state()
    expect_sub = st.get('sub') or jwt_sub(api.token)
    results = []           # (表, 动作, ok, 说明)
    owners = {}
    created = []           # 逆序清理
    ids = {}

    def rec(table, action, ok, note=''):
        results.append((table, action, ok, note))
        print('%s  %-12s %-22s %s' % ('PASS' if ok else 'FAIL', table, action, note))

    # 依赖顺序：父表在前，子表用父 id
    def do(table, body, action='INSERT'):
        row, err = insert(api, table, body)
        if err:
            rec(table, action, False, err)
            return None
        row_id = row.get('id')
        ids[table] = row_id
        owner = str(row.get('owner_id') or '')
        owners[table] = owner
        created.append((table, row_id))
        rec(table, action, True, 'id=%s owner=%s' % (row_id, owner or '(空)'))
        return row

    # 1) habits
    if do('habits', {'name': MARK, 'icon': 'circle', 'color': '#0A84FF',
                     'target': '每天', 'sort_order': 999}):
        # 2) checkins（挂在刚建的 habit 上）
        do('checkins', {'habit_id': ids['habits'], 'day': '2001-01-01', 'note': MARK})
    else:
        rec('checkins', 'INSERT', False, '跳过：habits 未建成，无父 id')

    # 3) health_daily
    do('health_daily', {'day': '2001-01-01', 'sleep_total': 7.5, 'hrv': 60,
                        'resting_hr': 55, 'stress': 30, 'training_load': 88,
                        'steps': 8000, 'source': 'probe'})

    # 4) activities
    do('activities', {'external_id': MARK + '-' + uuid.uuid4().hex[:8], 'day': '2001-01-01',
                      'type': 'run', 'name': MARK, 'duration_sec': 1800,
                      'distance_m': 5000, 'avg_hr': 140, 'calories': 300})

    # 5) books → 6) notes
    if do('books', {'title': MARK + '-' + uuid.uuid4().hex[:6], 'author': 'probe',
                    'status': 'reading', 'progress': 5, 'source': 'probe'}):
        do('notes', {'book_id': ids['books'], 'chapter': MARK, 'content': MARK + '-' + uuid.uuid4().hex[:8],
                     'page': 1})
    else:
        rec('notes', 'INSERT', False, '跳过：books 未建成，无父 id')

    # 7) study_plans → 8) study_logs
    if do('study_plans', {'title': MARK, 'target_per_week': 3, 'sort_order': 999}):
        do('study_logs', {'plan_id': ids['study_plans'], 'day': '2001-01-01', 'note': MARK})
    else:
        rec('study_logs', 'INSERT', False, '跳过：study_plans 未建成，无父 id')

    # 9) app_kv
    do('app_kv', {'k': MARK + '-' + uuid.uuid4().hex[:8], 'v': {'probe': True}})

    # --- 回读：RLS 过滤掉的行在这里会暴露（INSERT 201 但 SELECT 0 行）---
    for table, row_id in created:
        status, rows = api.db(table, 'select=id,owner_id&id=eq.%s' % row_id)
        if status >= 300:
            rec(table, 'SELECT 回读', False, 'HTTP %s %s' % (status, err_text(rows)))
        elif not isinstance(rows, list) or len(rows) != 1:
            rec(table, 'SELECT 回读', False, '读到 %s 行（应为 1）' % (
                len(rows) if isinstance(rows, list) else '?'))
        else:
            rec(table, 'SELECT 回读', True, '可见')

    # --- 改一列：PATCH 走的是 UPDATE 策略，和 INSERT 是两道检查 ---
    for table, row_id in created:
        status, payload = api.db(table, 'id=eq.%s&select=id' % row_id, 'PATCH',
                                 {'owner_id': owners.get(table)},
                                 prefer='return=representation')
        ok = status < 300 and isinstance(payload, list) and len(payload) == 1
        rec(table, 'PATCH 更新', ok, '' if ok else 'HTTP %s %s' % (status, err_text(payload)))

    # --- 身份一致性：绝不能是 anon，9 张表必须是同一个 owner ---
    distinct = sorted(set(v for v in owners.values() if v))
    if 'anon' in owners.values():
        rec('（全部）', 'owner 校验', False, '出现 owner_id=anon，写入身份没带上')
    elif len(distinct) > 1:
        rec('（全部）', 'owner 校验', False, 'owner 不一致：%s' % distinct)
    elif expect_sub and distinct and distinct[0] != expect_sub:
        rec('（全部）', 'owner 校验', False,
            'owner=%s 与 JWT sub=%s 不一致' % (distinct[0], expect_sub))
    elif distinct:
        ok = 'owner 一致 = %s' % distinct[0]
        if expect_sub:
            ok += '（= JWT sub）'
        rec('（全部）', 'owner 校验', True, ok)
    else:
        rec('（全部）', 'owner 校验', False, '没有任何一张表写入成功，无法判定 owner')

    # --- 清理（子表在前；--keep 时保留，方便到界面肉眼确认）---
    if keep:
        print('\n--keep：探针数据已保留，界面上应能看到（刷新后应仍在）：')
        for table, row_id in created:
            print('  %s id=%s' % (table, row_id))
    else:
        cleaned_fail = []
        for table, row_id in reversed(created):
            status, payload = api.db(table, 'id=eq.%s&select=id' % row_id, 'DELETE',
                                     prefer='return=representation')
            ok = status < 300
            rec(table, 'DELETE 清理', ok, '' if ok else 'HTTP %s %s ＜-- 残留 id=%s' % (
                status, err_text(payload), row_id))
            if ok:
                status2, rows = api.db(table, 'select=id&id=eq.%s' % row_id)
                if isinstance(rows, list) and rows:
                    cleaned_fail.append((table, row_id))
        if cleaned_fail:
            rec('（全部）', '清理确认', False, '仍在库里：%s' % cleaned_fail)

    # --- 汇总 ---
    failed = [r for r in results if not r[2]]
    print('\n' + '=' * 62)
    print('表覆盖：%d/9  检查项：%d  通过：%d  失败：%d'
          % (len({t for t, _, _, _ in results if t in
                  ('habits', 'checkins', 'health_daily', 'activities', 'books',
                   'notes', 'study_plans', 'study_logs', 'app_kv')}),
             len(results), len(results) - len(failed), len(failed)))
    if failed:
        print('失败项：')
        for t, a, _, note in failed:
            print('  - %s / %s：%s' % (t, a, note))
        return 1
    print('全部通过：9 张表都写进去、读得回、改得动，owner 一致且非 anon。')
    return 0


def main():
    ap = argparse.ArgumentParser(description='线上写入探测（9 张表逐项验证）')
    ap.add_argument('--email', help='发验证码到该邮箱')
    ap.add_argument('--code', help='用收到的 6 位码换会话，然后跑探测')
    ap.add_argument('--keep', action='store_true', help='保留探针数据不做清理')
    args = ap.parse_args()

    endpoint, key = load_config()
    api = Api(endpoint, key)

    if args.email:
        send_code(api, args.email)
        return 0

    st = load_state()
    api.token = st.get('access_token')
    if args.code:
        login(api, args.code.strip())
    elif not api.token:
        print('未登录。先运行：python3 tests/write_probe.py --email <你的邮箱>')
        return 2
    elif st.get('expires_at') and st['expires_at'] < int(time.time() * 1000) + 30000:
        if not refresh(api):
            print('缓存的会话已过期且刷新失败，重新走 --email')
            return 2
    return run(api, args.keep)


if __name__ == '__main__':
    sys.exit(main())
