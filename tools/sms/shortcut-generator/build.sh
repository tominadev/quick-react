#!/bin/bash
# 编译命令行版，产出同目录的 shortcut-generator。
#
# 有 .env 就把端点、凭证和模板一起编进二进制（编完双击即用、挪到别处也能跑）；没有 .env 也能
# 编——内置值留空，运行时再从 .env 或环境变量取。**干净检出的仓库必须能编译，所以 .env 不是必需的。**
# 注意：带凭证编出来的二进制和 Embedded.swift 含明文密钥，都已 gitignore，不要分享。
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; else echo "（没有 .env，编出的二进制运行时再读配置）"; fi

{
	echo '// 由 build.sh 生成，勿手改。带凭证时含明文密钥，切勿提交或分享。'
	echo "let EMBEDDED_ENDPOINT = #\"${SMS_API_ENDPOINT}\"#"
	echo "let EMBEDDED_KEY = #\"${SMS_PROVISIONING_KEY}\"#"
	echo "let EMBEDDED_TARGET = ${TARGET_AVAILABLE:-0}"
	echo "let EMBEDDED_INTERVAL = ${INTERVAL:-0}"
	echo 'let EMBEDDED_TEMPLATE = #"""'
	cat templates/sms-template.xml
	echo
	echo '"""#'
} > Sources/Core/Embedded.swift
chmod 600 Sources/Core/Embedded.swift 2>/dev/null || true

swiftc -O Sources/Core/*.swift Sources/CLI/main.swift -o shortcut-generator
echo "✅ 已生成 $(pwd)/shortcut-generator"
