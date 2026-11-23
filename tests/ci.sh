#!/bin/sh
# 一键发布前校验：构建 → 产物检查 → schema 一致性 → DOM 回归 → 线上匿名写入探测
# 任何一步「跳过」都算失败：跳过等于这次没校验，不能当通过放行。
# 平台：macOS / Linux 直接跑；Windows 用 Git Bash（商店版 Python 只有 python.exe，
#       所以解释器按 PYTHON 环境变量 → python3 → python 的顺序探测）。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PY=${PYTHON:-}
if [ -z "$PY" ]; then
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY=$c; break; fi
  done
fi
if [ -z "$PY" ]; then
  echo '没找到 python，请先安装 Python 3.10+ 或设置 PYTHON 环境变量'
  exit 1
fi

echo '== 构建 =='
"$PY" build.py
echo '== 发布前检查 =='
"$PY" build.py --check
echo '== 数据库结构一致性 =='
"$PY" tests/schema_check.py
echo '== DOM 回归 =='
"$PY" tests/regression.py
echo '== 匿名写入探测 =='
set +e
"$PY" tests/anon_probe.py
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
