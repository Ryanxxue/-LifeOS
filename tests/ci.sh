#!/bin/sh
# 一键发布前校验：构建 → 产物检查 → schema 一致性 → DOM 回归 → 线上匿名写入探测
# 任何一步「跳过」都算失败：跳过等于这次没校验，不能当通过放行。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
echo '== 构建 =='
python3 build.py
echo '== 发布前检查 =='
python3 build.py --check
echo '== 数据库结构一致性 =='
python3 tests/schema_check.py
echo '== DOM 回归 =='
python3 tests/regression.py
echo '== 匿名写入探测 =='
set +e
python3 tests/anon_probe.py
PROBE=$?
set -e
if [ "$PROBE" -eq 2 ]; then
  echo '匿名探测被跳过（网络不可达），本次校验不算通过'
  exit 1
fi
if [ "$PROBE" -ne 0 ]; then
  exit "$PROBE"
fi
echo '全部通过'
