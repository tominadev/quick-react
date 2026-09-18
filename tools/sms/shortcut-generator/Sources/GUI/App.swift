import SwiftUI

// SMS Shortcut 生成器 —— 图形前端（双击即用，不需要终端）。
//
// 业务逻辑全在 Sources/Core/，与命令行前端是同一份：这里只负责界面、把日志显示出来、
// 把「停止」按钮接到 Core 的 isCancelled 上。

@main
struct SMSGeneratorApp: App {
	var body: some Scene {
		WindowGroup("SMS 快捷指令生成器") {
			ContentView().frame(minWidth: 560, minHeight: 460)
		}
		.windowResizability(.contentSize)
	}
}

/// `.app` 里不能往自己的包里写东西，状态文件放用户资料库；`.env` 则找 `.app` 旁边的那一份，
/// 运维改配置不必重新编译。
enum AppPaths {
	static var envPath: String {
		Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".env").path
	}
	static var statePath: String {
		let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
			.appendingPathComponent("SMSShortcutGenerator", isDirectory: true)
		try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		return directory.appendingPathComponent("state.json").path
	}
}

@MainActor
final class Model: ObservableObject {
	@Published var targetText = ""
	@Published var intervalText = ""
	@Published var logText = ""
	@Published var running = false
	@Published var logSeq = 0            // 变一次触发一次日志自动滚动

	private var task: Task<Void, Never>?
	private let settings = try? Settings(envPath: AppPaths.envPath, templatePath: nil)

	init() {
		targetText = (settings?.target).map { $0 > 0 ? String($0) : "100" } ?? "100"
		intervalText = (settings?.interval).map { $0 > 0 ? String(Int($0)) : "" } ?? ""
	}

	func line(_ text: String) { logText += (logText.isEmpty ? "" : "\n") + text; logSeq += 1 }
	func clear() { logText = ""; logSeq += 1 }

	/// 生成逻辑跑在后台，日志要跳回主线程才能更新界面。
	private func logger() -> (@Sendable (String) -> Void) {
		{ text in DispatchQueue.main.async { self.line(text) } }
	}

	private func ready() -> (Client, String)? {
		guard let settings else {
			line("❌ 缺少端点/凭证/模板：把 .env 放在这个 .app 旁边，或用 build-gui.sh 带 .env 重新编译")
			return nil
		}
		return (Client(config: settings.config), settings.template)
	}

	func check() {
		guard !running, let (client, template) = ready() else { return }
		running = true
		line("—— 自检 ——")
		let log = logger()
		task = Task.detached(priority: .userInitiated) {
			do {
				let (url, machine, available) = try await client.fetchConfig()
				try signSelfTest(template: template)
				log("✅ OK：可达，凭证有效，机器 \(machine)，当前可用 \(available) 个，本地签名可用（接收地址 \(url.count) 字节）")
			} catch let error as GenError {
				if case .sign(let message) = error { log("❌ 签名失败——请确认已登录 iCloud 且能运行「快捷指令」。\(message)") }
				else { log("❌ 检查失败：\(error)") }
			} catch {
				log("❌ 检查失败：\(error)")
			}
			await MainActor.run { self.running = false }
		}
	}

	func start() {
		guard !running, let target = Int(targetText), target > 0 else { line("请填写有效的目标可用数量"); return }
		guard let (client, template) = ready() else { return }
		let interval = Double(intervalText) ?? 0
		let statePath = AppPaths.statePath
		running = true
		line(interval > 0 ? "—— 循环补货：每 \(Int(interval)) 秒补到 \(target) 个（点停止结束）——" : "—— 补货到 \(target) 个 ——")
		let log = logger()
		task = Task.detached(priority: .userInitiated) {
			let store = StateStore(path: statePath)
			repeat {
				let outcome = await replenishOnce(client: client, template: template, target: target, store: store,
				                                  keepLocal: false, log: log, isCancelled: { Task.isCancelled })
				if case .signBroken(let message) = outcome {
					log("❌ 签名失败，已停止——请确认已登录 iCloud 且能运行「快捷指令」。\(message)")
					break
				}
				if case .cancelled = outcome { break }
				if interval <= 0 || Task.isCancelled { break }
				try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
			} while !Task.isCancelled
			await MainActor.run { self.running = false; self.line("—— 结束 ——") }
		}
	}

	func stop() { task?.cancel(); line("正在停止 …") }
}

struct ContentView: View {
	@StateObject private var model = Model()

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Text("SMS 快捷指令生成器").font(.title2).bold()
			Text("按「目标可用数量」补货：工具只补差额，已经够了就不生成。").font(.caption).foregroundStyle(.secondary)

			HStack(spacing: 16) {
				VStack(alignment: .leading, spacing: 4) {
					Text("目标可用数量").font(.caption)
					TextField("如 100", text: $model.targetText).frame(width: 120).disabled(model.running)
				}
				VStack(alignment: .leading, spacing: 4) {
					Text("循环间隔（秒，留空=只跑一次）").font(.caption)
					TextField("留空", text: $model.intervalText).frame(width: 140).disabled(model.running)
				}
				Spacer()
			}

			HStack(spacing: 10) {
				Button("自检") { model.check() }.disabled(model.running)
				Button("开始补货") { model.start() }.disabled(model.running).keyboardShortcut(.defaultAction)
				Button("停止") { model.stop() }.disabled(!model.running)
				Button("清空日志") { model.clear() }.disabled(model.running)
				if model.running { ProgressView().controlSize(.small).padding(.leading, 4) }
				Spacer()
			}

			ScrollViewReader { proxy in
				ScrollView {
					Text(model.logText.isEmpty ? "日志会显示在这里…" : model.logText)
						.font(.system(.footnote, design: .monospaced))
						.frame(maxWidth: .infinity, alignment: .leading)
						.textSelection(.enabled)
						.padding(8)
						.id("logbottom")
				}
				.background(Color(nsColor: .textBackgroundColor))
				.overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.3)))
				.onChange(of: model.logSeq) { withAnimation { proxy.scrollTo("logbottom", anchor: .bottom) } }
			}
		}
		.padding(16)
	}
}
