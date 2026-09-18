#!/usr/bin/env bash
# quick-react 依赖安装：系统依赖 → Node（fnm）→ 项目依赖 → 全局 PM2。
#
# 这个脚本只负责把依赖装齐，不构建、不注册服务、不启动任何进程。
# 服务的注册、启动、开机自启和卸载都在维护工具箱里：node scripts/maintenance-toolbox.cjs
#
# 可重复执行：每一步都先检查现状，已经装好的跳过，配置文件也不会被追加第二遍。
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# package.json 的 engines 要求 Node >= 22.13（内置 node:sqlite），这里默认装 24。
NODE_VERSION="${NODE_VERSION:-24}"
# fnm 安装目录与其官方安装脚本在 Linux 上的默认值保持一致。
FNM_DIR="${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}"

SKIP_PROJECT=0  # 只装系统依赖和 Node，不装项目依赖和 PM2
SKIP_PM2=0      # 不安装全局 PM2

APT_PACKAGES=(curl unzip ca-certificates)
# ~/.bashrc 里那段 fnm 初始化的边界标记，靠它做到重复执行不重复追加。
PROFILE_BEGIN='# >>> fnm (quick-react install.sh) >>>'
PROFILE_END='# <<< fnm (quick-react install.sh) <<<'

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "第 ${LINENO} 行执行失败，安装中止"' ERR

usage() {
	cat <<'EOF'
用法：./install.sh [选项]

安装内容：系统依赖（curl、unzip、ca-certificates）、fnm、Node、项目依赖、全局 PM2。
不包含服务注册和启动，那些在维护工具箱里：node scripts/maintenance-toolbox.cjs

选项：
  --node-version <版本>   安装的 Node 主版本，默认 24（package.json 要求 >= 22.13）
  --skip-project          只装系统依赖和 Node，不装项目依赖和 PM2
  --skip-pm2              不安装全局 PM2
  -h, --help              显示本帮助

环境变量 NODE_VERSION、FNM_DIR 与对应选项等价，选项优先。
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--node-version) NODE_VERSION="${2:?--node-version 需要一个版本号}"; shift 2 ;;
		--node-version=*) NODE_VERSION="${1#*=}"; shift ;;
		--skip-project) SKIP_PROJECT=1; shift ;;
		--skip-pm2) SKIP_PM2=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "未知选项：$1" ;;
	esac
done

# 非 root 时系统包安装走 sudo；npm 全局包装在 fnm 目录里，不需要提权。
SUDO=''
if [ "$(id -u)" -ne 0 ]; then
	command -v sudo >/dev/null 2>&1 || die "需要 root 权限，或先安装 sudo"
	SUDO='sudo'
fi

install_system_packages() {
	command -v apt-get >/dev/null 2>&1 || die "只支持基于 apt 的发行版（Debian/Ubuntu），请手动安装：${APT_PACKAGES[*]}"
	local missing=() pkg
	for pkg in "${APT_PACKAGES[@]}"; do
		dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q '^install ok installed$' || missing+=("$pkg")
	done
	if [ "${#missing[@]}" -eq 0 ]; then
		log "系统依赖已齐全：${APT_PACKAGES[*]}"
		return
	fi
	log "安装系统依赖：${missing[*]}"
	$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
	$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
}

install_fnm() {
	if [ -x "$FNM_DIR/fnm" ]; then
		log "fnm 已安装：$FNM_DIR/fnm"
		return
	fi
	log "安装 fnm 到 $FNM_DIR"
	# --skip-shell 是关键：官方安装脚本每执行一次就往 ~/.bashrc 追加一段初始化，
	# 从不检查是否已经存在，重复执行就会堆出好几份。这里让它只装二进制，
	# shell 初始化由 setup_profile 用标记块管理。
	curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_DIR" --skip-shell
	[ -x "$FNM_DIR/fnm" ] || die "fnm 安装失败：$FNM_DIR/fnm 不存在"
}

# 把 fnm 载入当前进程。原来的写法是 source ~/.bashrc，但 Debian 的 ~/.bashrc
# 开头就对非交互式 shell 直接 return，脚本里 source 它拿不到任何东西，
# 后面的 fnm install 只会 command not found。
load_fnm() {
	export PATH="$FNM_DIR:$PATH"
	eval "$(fnm env --shell bash)"
}

install_node() {
	if fnm list | grep -qE "v${NODE_VERSION}(\.|[[:space:]]|$)"; then
		log "Node ${NODE_VERSION} 已安装"
	else
		log "安装 Node ${NODE_VERSION}"
		fnm install "$NODE_VERSION"
	fi
	fnm use "$NODE_VERSION"
	fnm default "$NODE_VERSION"
}

# 删掉 profile 里已有的全部 fnm 初始化片段：一种是本脚本写的标记块，
# 另一种是 fnm 官方安装脚本追加的「# fnm ... fi」六行块（历史遗留，可能有好几份）。
# 删完由 setup_profile 重新写入唯一一份，这样脚本执行多少次都只剩一段配置。
strip_fnm_blocks() {
	local profile="$1"
	awk -v begin="$PROFILE_BEGIN" -v end="$PROFILE_END" '
		# 本脚本的标记块
		$0 == begin { inMarked = 1; next }
		inMarked { if ($0 == end) inMarked = 0; next }
		# fnm 官方安装脚本追加的块：以 "# fnm" 开头，到单独一行 "fi" 结束
		$0 == "# fnm" { inOfficial = 1; next }
		inOfficial { if ($0 == "fi") inOfficial = 0; next }
		{ print }
	' "$profile"
}

# 把 fnm 初始化写进 ~/.bashrc，让之后登录的交互式 shell 直接能用 node。
setup_profile() {
	local profile="$HOME/.bashrc" existing backup
	[ -f "$profile" ] || : >"$profile"
	# 现有 fnm 片段的数量：标记块和官方块各算一份
	existing="$(grep -cE "^(# fnm|$(printf '%s' "$PROFILE_BEGIN" | sed 's/[][\.*^$/]/\\&/g'))$" "$profile" || true)"
	if [ "$existing" -gt 1 ]; then
		backup="${profile}.bak.$(date +%Y%m%d%H%M%S)"
		cp -p "$profile" "$backup"
		warn "~/.bashrc 里有 ${existing} 段重复的 fnm 初始化（以前的安装脚本反复追加的），已备份到 ${backup} 并合并为一段"
	elif [ "$existing" -eq 1 ]; then
		log "~/.bashrc 已有 fnm 初始化，改写为当前配置"
	else
		log "写入 fnm 初始化到 ~/.bashrc"
	fi
	{
		strip_fnm_blocks "$profile"
		printf '\n%s\n' "$PROFILE_BEGIN"
		printf 'export PATH="%s:$PATH"\n' "$FNM_DIR"
		printf 'eval "$(fnm env --use-on-cd --shell bash)"\n'
		printf '%s\n' "$PROFILE_END"
	} >"${profile}.tmp.$$"
	mv "${profile}.tmp.$$" "$profile"
}

# 拿 package.json 的 engines.node 跟实际装上的版本比一次，
# 避免 --node-version 传了个低版本，装完到运行时才报错。
verify_node_version() {
	local required current lowest
	log "Node $(node -v)，npm $(npm -v)"
	required="$(node -p "require('$SCRIPT_DIR/package.json').engines?.node ?? ''" 2>/dev/null || true)"
	current="$(node -p 'process.versions.node')"
	case "$required" in
		'>='*) required="${required#>=}" ;;
		*) return 0 ;;  # 不是 ">=x.y" 这种简单形式就不比了，交给运行时报错
	esac
	lowest="$(printf '%s\n%s\n' "$required" "$current" | sort -V | head -n 1)"
	[ "$lowest" = "$required" ] || die "package.json 要求 Node >= ${required}，当前是 ${current}，请用 --node-version 指定更高版本"
}

install_project_deps() {
	log "安装项目依赖（重新解析到范围内最新）"
	# package-lock.json 不进版本库（见 .gitignore），所以用 npm install 而不是 npm ci。
	#
	# **先删掉本地那份锁文件再装。** 留着的话 npm install 会尽量沿用里面已经解析好的版本，
	# 只在 package.json 的范围要求时才动——于是「出问题跑一下 install.sh」很可能什么都没变，
	# 装出来的还是那套有问题的依赖。删掉才会真的重新解析。
	#
	# 仍然受 package.json 里 `^` 的约束，**不会跨大版本**：prisma 把 latest 标签指向了
	# 8.0.0-rc.15 这种候选版，而范围限制会把它挡在外面。跨大版本是要单独排期读 changelog
	# 的事，不该由一次「重装依赖」顺手完成。
	rm -f "$SCRIPT_DIR/package-lock.json"
	(cd "$SCRIPT_DIR" && npm install --no-fund --no-audit)
	# 依赖换过之后到底还能不能跑，只有测试知道——脚本不替人决定要不要跑，但要说出来。
	log "依赖已装齐。建议接着跑一次：npm run typecheck && npm run build:worker"
}

install_pm2() {
	if command -v pm2 >/dev/null 2>&1; then
		log "PM2 已安装：$(pm2 -v 2>/dev/null | tail -n 1)"
		return
	fi
	# 与 scripts/maintenance-service-pm2.cjs 里 PM2_INSTALL_COMMAND 提示的命令一致。
	log "安装 PM2（npm install -g pm2）"
	npm install -g pm2 --no-fund --no-audit
}

main() {
	install_system_packages
	install_fnm
	load_fnm
	install_node
	setup_profile
	verify_node_version

	if [ "$SKIP_PROJECT" -eq 1 ]; then
		log "按 --skip-project 跳过项目依赖和 PM2"
	else
		install_project_deps
		if [ "$SKIP_PM2" -eq 1 ]; then
			log "按 --skip-pm2 跳过 PM2"
		else
			install_pm2
		fi
	fi

	log "依赖安装完成"
	cat <<'EOF'

当前 shell 还没有 node，先执行（或重新登录）：
  source ~/.bashrc

接下来：
  node esbuild.cjs                    # 构建并启动（默认 8088 端口）
  npm run dev                         # 开发模式：构建 + 监听
  node scripts/maintenance-toolbox.cjs  # 维护工具箱：注册/启动/开机自启/卸载 PM2 服务
EOF
}

main "$@"
