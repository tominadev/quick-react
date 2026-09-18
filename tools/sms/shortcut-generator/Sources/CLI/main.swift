import Foundation

// SMS Shortcut 生成器 —— 命令行前端。
//
//   shortcut-generator --check                          校验 .env / 可达性 / 凭证 / 余量 / 本地签名
//   shortcut-generator --count 50                       补货：维持池子有 50 个可用
//   shortcut-generator --count 50 --interval 300        循环：每 300 秒补到 50 个
//   可选：--keep-local --task-id T --env <path> --state <path> --template <path>
//
// 业务逻辑全在 Sources/Core/，这里只做参数解析、日志落点和退出码。

let arguments = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
	guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
	return arguments[index + 1]
}
func flag(_ name: String) -> Bool { arguments.contains(name) }

func log(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
func fail(_ message: String) -> Never { log(message); exit(1) }

// 默认路径相对**二进制自己所在的目录**，这样双击运行、或把二进制挪到别处也能找到同目录的
// .env / 模板 / 状态文件。
let executableDirectory = URL(fileURLWithPath: CommandLine.arguments.first ?? ".").deletingLastPathComponent().path
let envPath = option("--env") ?? "\(executableDirectory)/.env"
let statePath = option("--state") ?? "\(executableDirectory)/.shortcut-gen-state.json"
let templatePath = option("--template") ?? "\(executableDirectory)/templates/sms-template.xml"
let keepLocal = flag("--keep-local")

let settings: Settings
do { settings = try Settings(envPath: envPath, templatePath: templatePath) }
catch { fail("\(error)") }
let client = Client(config: settings.config)

let signHint = "签名失败——请确认这台 Mac 已登录 iCloud 且能运行「快捷指令」。原因: "

// ---- --check：可达性、凭证、余量，外加一次本地签名自检 ----------------------
if flag("--check") {
	do {
		let (url, machine, available) = try await client.fetchConfig()
		try signSelfTest(template: settings.template)
		log("OK  可达，凭证有效，机器 name=\(machine)，当前可用 \(available) 个，本地签名可用（接收地址 \(url.count) 字节）")
		exit(0)
	} catch let error as GenError {
		if case .sign(let message) = error { fail("\(signHint)\(message)") }
		fail("检查失败: \(error)")
	} catch {
		fail("检查失败: \(error)")
	}
}

// ---- 目标可用数量与循环间隔：命令行 > 环境变量 / .env / 编译内置 ------------
guard let target = option("--count").flatMap(Int.init) ?? (settings.target > 0 ? settings.target : nil), target > 0 else {
	fail("""
	用法: --count N（目标可用数量）[--interval 秒] [--keep-local] | --check
	（也可以在 .env 里设 TARGET_AVAILABLE / INTERVAL，然后无参运行）
	""")
}
let interval = option("--interval").flatMap(Double.init) ?? settings.interval

let store = StateStore(path: statePath, taskID: option("--task-id"))

if interval > 0 {
	log("循环补货模式：每 \(Int(interval)) 秒补到 \(target) 个可用（Ctrl+C 停止）")
	while true {
		let outcome = await replenishOnce(client: client, template: settings.template, target: target,
		                                  store: store, keepLocal: keepLocal, log: log, isCancelled: { false })
		// 签名坏了是环境问题，接着循环只会无限重试同一个错。
		if case .signBroken(let message) = outcome { fail("\(signHint)\(message)") }
		try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
	}
} else {
	switch await replenishOnce(client: client, template: settings.template, target: target,
	                           store: store, keepLocal: keepLocal, log: log, isCancelled: { false }) {
	case .ok: exit(0)
	case .hadFailures, .cancelled: exit(1)
	case .signBroken(let message): fail("\(signHint)\(message)")
	}
}
