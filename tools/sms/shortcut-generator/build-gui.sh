#!/bin/bash
# 编译图形版，产出同目录的 SMS生成器.app（不需要 Xcode）。
# 配置来源与命令行版完全一致（见 build.sh 的说明）。
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; else echo "（没有 .env，.app 运行时读它旁边的 .env）"; fi

{
	echo '// 由 build-gui.sh 生成，勿手改。带凭证时含明文密钥，切勿提交或分享。'
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

APP="SMS生成器.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O Sources/Core/*.swift Sources/GUI/App.swift -o "$APP/Contents/MacOS/SMSGenerator"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SMS生成器</string>
  <key>CFBundleDisplayName</key><string>SMS生成器</string>
  <key>CFBundleIdentifier</key><string>local.sms.shortcut-generator</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>SMSGenerator</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# Apple Silicon 要求签名才能运行（ad-hoc 就够）；不签的话拷到别的 M 芯片 Mac 会报「已损坏」。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "✅ 已生成 $(pwd)/$APP"
