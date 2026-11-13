#!/bin/sh
# 一键发布前校验：产物一致 + DOM 回归 + 线上匿名写入探测
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
echo '== 构建 =='
python3 build.py
echo '== 发布前检查 =='
python3 build.py --check
echo '== DOM 回归 =='
python3 tests/regression.py
echo '== 匿名写入探测 =='
python3 tests/anon_probe.py
echo '全部通过'
