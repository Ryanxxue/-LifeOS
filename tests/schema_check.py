#!/usr/bin/env python3
"""数据库结构与代码的一致性检查。

背景：9 张表的结构、唯一索引与 RLS 策略原先只存在于云端，换环境无法重建，
策略被改回 anon 可写也没有版本记录。这里把 db/*.sql 纳入仓库并做静态校验：
  1) schema.sql 覆盖 app.js 实际访问的每一张表（新增表忘了写 DDL 会失败）；
  2) 每张表都有 RLS 策略，且只授予 authenticated（不能出现 to anon）；
  3) 关键唯一约束/索引存在（重复写入、备份恢复都依赖它们）。
"""
import re
import sys

SCHEMA = 'db/schema.sql'
POLICIES = 'db/policies.sql'
APP = 'app.js'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def main():
    problems = []
    try:
        schema = read(SCHEMA)
        policies = read(POLICIES)
        app = read(APP)
    except FileNotFoundError as e:
        print('FAIL | 缺少文件 | %s' % e)
        return 1

    schema_tables = set(re.findall(r'create table if not exists public\.(\w+)', schema, re.I))
    # app.js 里实际访问的表：DB.from('x') / insertRows('x' / BACKUP_TABLES
    used = set(re.findall(r"DB\.from\('(\w+)'\)", app)) | \
        set(re.findall(r"insertRows\('(\w+)'", app)) | \
        set(re.findall(r"selectPaged\('(\w+)'", app))
    backup = re.search(r'const BACKUP_TABLES = \[([^\]]+)\]', app)
    if backup:
        used |= set(re.findall(r"'(\w+)'", backup.group(1)))

    missing = sorted(used - schema_tables)
    if missing:
        problems.append('schema.sql 缺少表：' + '、'.join(missing))
    if len(schema_tables) < 9:
        problems.append('schema.sql 表数量异常：%d' % len(schema_tables))

    # 每张表都要有策略，且只给 authenticated
    for t in sorted(schema_tables):
        m = re.search(r'create policy %s_owner on public\.%s for all to authenticated' % (t, t),
                      policies)
        if not m:
            problems.append('%s 缺少 authenticated 策略' % t)
    if re.search(r'\bto\s+anon\b', policies, re.I):
        problems.append('policies.sql 出现了 to anon（会把库暴露给未登录请求）')

    # 依赖的唯一约束/索引
    for name in ['checkins_owner_id_habit_id_day_key', 'health_daily_owner_id_day_key',
                 'activities_owner_id_external_id_key', 'notes_dedupe_idx',
                 'study_logs_dedupe_idx', 'app_kv_owner_id_k_key']:
        if name not in schema:
            problems.append('schema.sql 缺少唯一约束/索引 %s' % name)

    if problems:
        print('FAIL | 结构一致性')
        for p in problems:
            print('  - ' + p)
        return 1
    print('PASS | 数据库结构一致性 | %d 张表，全部仅 authenticated，关键唯一约束齐全'
          % len(schema_tables))
    return 0


if __name__ == '__main__':
    sys.exit(main())
