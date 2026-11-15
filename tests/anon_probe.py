#!/usr/bin/env python3
"""线上安全探测：确认未登录请求无法写入数据库。

RLS 策略已收紧为仅 authenticated（2026-11-13）。该脚本在 CI 里跑，
一旦有人把策略改回 anon 可写，会立刻失败。

2026-11-15：原来只探 habits 一张表，其余 8 张是盲区——新增表或改策略时
很容易只漏一张而没人发现。现在逐表探测，每张表发一次注定失败的 INSERT，
不会留下数据（RLS 在写入前就拒绝了）。

退出码：0 全部被拒；1 有任一张表可写（真问题）；2 网络不可达（校验没做）。
"""
import json
import re
import sys
import urllib.error
import urllib.request

CONFIG = 'config.js'

# 每张表用最小合法 payload（只填无默认值的 NOT NULL 列），
# 这样失败原因一定是 RLS 而不是「缺字段」——否则会掩盖策略问题。
PROBES = [
    ('habits', {'name': '__ANON_PROBE__'}),
    ('checkins', {'habit_id': 1, 'day': '2000-01-01'}),
    ('health_daily', {'day': '2000-01-01'}),
    ('activities', {'external_id': '__anon_probe__', 'day': '2000-01-01'}),
    ('books', {'title': '__ANON_PROBE__'}),
    ('notes', {'book_id': 1, 'content': '__ANON_PROBE__'}),
    ('study_plans', {'title': '__ANON_PROBE__'}),
    ('study_logs', {'plan_id': 1, 'day': '2000-01-01'}),
    ('app_kv', {'k': '__ANON_PROBE__', 'v': {}}),
]


def main():
    with open(CONFIG, encoding='utf-8') as f:
        cfg = f.read()
    endpoint = re.search(r'endpoint:\s*"([^"]+)"', cfg)
    key = re.search(r'publishableKey:\s*"([^"]+)"', cfg)
    if not endpoint or not key:
        print('无法从 config.js 解析 endpoint / publishableKey')
        return 1
    base = endpoint.group(1).rstrip('/') + '/.cloud/database/rest/'

    failed, skipped = [], []
    for table, body in PROBES:
        req = urllib.request.Request(base + table, data=json.dumps(body).encode('utf-8'),
                                     method='POST', headers={
                                         'Content-Type': 'application/json',
                                         'x-wb-webapp-access-key': key.group(1),
                                         'Prefer': 'return=representation',
                                     })
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                code, payload = r.status, r.read(200)
        except urllib.error.HTTPError as e:
            code, payload = e.code, e.read(200)
        except Exception as e:
            # 不能用 0 冒充通过：网络不通时这次安全校验其实没做
            print('SKIP %-13s 网络不可达（%s）' % (table, e))
            skipped.append(table)
            continue

        text = payload.decode('utf-8', 'ignore')
        try:
            j = json.loads(text)
            brief = ('%s %s' % (j.get('code', ''), (j.get('message') or '')[:70])).strip()
        except Exception:
            brief = text[:70]
        if code >= 400:
            print('PASS %-13s HTTP %s %s' % (table, code, brief))
        else:
            print('FAIL %-13s HTTP %s 竟然写进去了：%s' % (table, code, brief))
            failed.append(table)

    print('---')
    if failed:
        print('匿名写入探测：%d 张表可被未登录请求写入 → %s' % (len(failed), ','.join(failed)))
        return 1
    if len(skipped) == len(PROBES):
        print('SKIP 匿名写入探测：网络不可达，本次未校验')
        return 2
    print('匿名写入探测：%d/%d 张表均拒绝未登录写入%s' %
          (len(PROBES) - len(skipped), len(PROBES),
           ('（%d 张跳过）' % len(skipped)) if skipped else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
