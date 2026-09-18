#!/bin/bash
# 双击运行（补货）。Finder 会用「终端」执行它。
# 源码、模板或 .env 有更新时自动重新编译，然后问你补到多少个。
cd "$(dirname "$0")" || exit 1
BIN="$(pwd)/shortcut-generator"

if [ ! -f .env ]; then
	echo "❌ 找不到 .env（应在 $(pwd)/.env）。照着 .env.example 建一份，权限设成 600。"
	read -n 1 -s -r -p "按任意键关闭 …"; echo; exit 1
fi

needs_build=0
[ -x "$BIN" ] || needs_build=1
for f in Sources/Core/*.swift Sources/CLI/main.swift templates/sms-template.xml .env; do
	[ "$f" -nt "$BIN" ] && needs_build=1
done
if [ "$needs_build" = 1 ]; then
	echo "首次运行或有更新，先编译 …"
	./build.sh || { echo "❌ 编译失败"; read -n 1 -s -r -p "按任意键关闭 …"; echo; exit 1; }
	echo
fi

echo "==== SMS Shortcut 生成器（补货）===="
echo "端点: $(grep '^SMS_API_ENDPOINT' .env | cut -d= -f2-)"
echo "（下面填「池子里要维持多少个可用」= 目标数量，工具只补差额；留空 = 只做连接自检）"
read -r -p "目标可用数量: " COUNT
read -r -p "循环间隔秒数（留空 = 只跑一次）: " INTERVAL
echo

if [ -z "$COUNT" ]; then
	"$BIN" --check
else
	ARGS=(--count "$COUNT")
	[ -n "$INTERVAL" ] && ARGS+=(--interval "$INTERVAL")
	"$BIN" "${ARGS[@]}"
fi

echo
read -n 1 -s -r -p "完成。按任意键关闭窗口 …"
echo
