import Foundation

// 把接收地址和令牌注入模板，交给 /usr/bin/shortcuts 签名。
//
// 签名是一次约 5~6 秒的苹果云端往返，没有办法加速，也**必须在已登录 iCloud 的图形会话里**跑
// （所以只能用用户级 LaunchAgent，不能用 root/LaunchDaemon）。

func runShortcutsSign(_ arguments: [String], timeout: TimeInterval = 90) throws {
	let process = Process()
	process.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
	process.arguments = arguments
	let errorPipe = Pipe()
	process.standardError = errorPipe
	try process.run()
	let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
	DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
	process.waitUntilExit()
	watchdog.cancel()
	if process.terminationStatus != 0 {
		let message = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "sign failed"
		throw GenError.sign(message.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces))
	}
}

/// 生成一个已签名的 .shortcut，返回文件字节。
///
/// 显示名由服务端下载接口决定（`sms-<token_id>.shortcut`，需求文档 §5.7），工具不参与命名。
func buildAndSign(template: String, receiveURL: String, token: String, workDir: URL, tag: String) throws -> Data {
	let filled = template
		.replacingOccurrences(of: "__RECEIVE_URL__", with: receiveURL)
		.replacingOccurrences(of: "__TOKEN__", with: token)
	// 先校验并规范化 plist：坏模板在这里快速失败，不白等一次 ~6 秒的签名往返。
	let plist = try PropertyListSerialization.propertyList(from: Data(filled.utf8), options: [], format: nil)
	let normalized = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
	let input = workDir.appendingPathComponent("\(tag)-unsigned.shortcut")
	let output = workDir.appendingPathComponent("\(tag)-signed.shortcut")
	try normalized.write(to: input)
	try runShortcutsSign(["sign", "--mode", "anyone", "--input", input.path, "--output", output.path])
	let data = try Data(contentsOf: output)
	try? FileManager.default.removeItem(at: input)
	return data
}

/// 本地签名自检：签一个随即丢弃的文件，不上传。没登录 iCloud、不能跑「快捷指令」都会在这里暴露。
func signSelfTest(template: String) throws {
	let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("sms-check-\(UUID().uuidString)")
	try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
	defer { try? FileManager.default.removeItem(at: workDir) }
	_ = try buildAndSign(template: template, receiveURL: "https://example.invalid/x", token: "selfcheck", workDir: workDir, tag: "check")
}
