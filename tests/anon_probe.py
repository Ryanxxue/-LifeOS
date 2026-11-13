#!/usr/bin/env python3
"""线上安全探测：确认未登录请求无法写入数据库。

RLS 策略已收紧为仅 authenticated（2026-11-13）。该脚本在 CI 里跑，
一旦有人把策略改回 anon 可写，会立刻失败。
只做一次注定失败的 INSERT，不会留下数据。
"""
import json
import re
import sys
import urllib.error
import urllib.request

CONFIG = 'config.js'
TABLE = 'habits'


def main():
    with open(CONFIG, encoding='utf-8') as f:
        cfg = f.read()
    endpoint = re.search(r'endpoint:\s*"([^"]+)"', cfg)
    key = re.search(r'publishableKey:\s*"([^"]+)"', cfg)
    if not endpoint or not key:
        print('无法从 config.js 解析 endpoint / publishableKey')
        return 1
    url = endpoint.group(1).rstrip('/') + '/.cloud/database/rest/' + TABLE
    body = json.dumps({'name': '__ANON_PROBE__', 'target': '每天',
                       'icon': 'sun', 'color': '#0A84FF'}).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type': 'application/json',
        'x-wb-webapp-access-key': key.group(1),
        'Prefer': 'return=representation',
    })
    code = None
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            code = r.status
            payload = r.read(300)
    except urllib.error.HTTPError as e:
        code = e.code
        payload = e.read(300)
    except Exception as e:
        # 不能用 0 冒充通过：网络不通时这次安全校验其实没做
        print('SKIP 匿名写入探测：网络不可达（%s）' % e)
        return 2

    ok = code is not None and code >= 400
    print('%s 匿名写入探测：HTTP %s %s' % ('PASS' if ok else 'FAIL', code,
                                          payload.decode('utf-8', 'ignore')[:160]))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
