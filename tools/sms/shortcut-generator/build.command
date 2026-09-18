#!/bin/bash
# 双击只编译（命令行版 + 图形版），不运行。
cd "$(dirname "$0")" || exit 1
./build.sh && ./build-gui.sh
echo
read -n 1 -s -r -p "完成。按任意键关闭窗口 …"
echo
