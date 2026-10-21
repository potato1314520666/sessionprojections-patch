#!/usr/bin/env bash
# 压测探针：每次 GUI 切换（模型/自动审查）后跑一次。
# 只要本脚本能正常返回，说明当前会话工具链活着 = 没有出现 sessionProjections 僵尸。
echo "probe $(date '+%H:%M:%S') : alive"
tmp="$HOME/.dsh/stress-probe-tmp.txt"
echo "$RANDOM $RANDOM" > "$tmp" && cat "$tmp" && rm -f "$tmp"
node -e "console.log('node-ok', process.version)" 2>/dev/null || echo "node-missing (非致命)"
