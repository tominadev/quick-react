import Foundation

// 连接配置与模板的来源。取值优先级：环境变量 > .env 文件 > 编译时内置（Embedded.swift）。
//
// 两个前端走同一条路径：CLI 读二进制同目录的 .env，GUI 读 .app 旁边的 .env。所以运维改配置
// 不必重新编译，两边的行为也不会各是一套。

struct Config {
	let endpoint: URL           // SMS_API_ENDPOINT，指向 shortcut-tokens.php
	let provisioningKey: String // SMS_PROVISIONING_KEY
}

enum SettingsError: Error, CustomStringConvertible {
	case missingCredentials, templateUnavailable(String), templatePlaceholders

	var description: String {
		switch self {
		case .missingCredentials:        return "缺少 SMS_API_ENDPOINT 或 SMS_PROVISIONING_KEY（环境变量、.env、编译内置都没有）"
		case .templateUnavailable(let p): return "模板不可读且无内置模板: \(p)"
		case .templatePlaceholders:      return "模板缺少占位符 __TOKEN__ / __RECEIVE_URL__"
		}
	}
}

func loadDotenv(_ path: String) -> [String: String] {
	guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
	var out: [String: String] = [:]
	for var line in text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) {
		line = line.trimmingCharacters(in: .whitespaces)
		if line.isEmpty || line.hasPrefix("#") { continue }   // 注释行不是变量
		guard let eq = line.firstIndex(of: "=") else { continue }
		let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
		var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
		if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") { value = String(value.dropFirst().dropLast()) }
		out[key] = value
	}
	return out
}

/// 一次读齐所有配置。`envPath` 为 nil 时只看环境变量和编译内置。
struct Settings {
	let config: Config
	let template: String
	let target: Int        // TARGET_AVAILABLE，0 表示未设
	let interval: Double   // INTERVAL 秒，0 表示不循环

	init(envPath: String?, templatePath: String?) throws {
		let dotenv = envPath.map(loadDotenv) ?? [:]
		func resolve(_ key: String, embedded: String) -> String? {
			if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty { return value }
			if let value = dotenv[key], !value.isEmpty { return value }
			return embedded.isEmpty ? nil : embedded
		}

		guard let endpoint = resolve("SMS_API_ENDPOINT", embedded: EMBEDDED_ENDPOINT).flatMap(URL.init(string:)),
		      let key = resolve("SMS_PROVISIONING_KEY", embedded: EMBEDDED_KEY) else { throw SettingsError.missingCredentials }
		config = Config(endpoint: endpoint, provisioningKey: key)

		// 模板：外部文件优先，它得真的是模板（含占位符）才算数，否则退回编译内置。
		if let path = templatePath, let text = try? String(contentsOfFile: path, encoding: .utf8), text.contains("__TOKEN__") {
			template = text
		} else if !EMBEDDED_TEMPLATE.isEmpty {
			template = EMBEDDED_TEMPLATE
		} else {
			throw SettingsError.templateUnavailable(templatePath ?? "（未指定）")
		}
		guard template.contains("__TOKEN__"), template.contains("__RECEIVE_URL__") else { throw SettingsError.templatePlaceholders }

		target = resolve("TARGET_AVAILABLE", embedded: EMBEDDED_TARGET > 0 ? String(EMBEDDED_TARGET) : "").flatMap(Int.init) ?? 0
		interval = resolve("INTERVAL", embedded: EMBEDDED_INTERVAL > 0 ? String(EMBEDDED_INTERVAL) : "").flatMap(Double.init) ?? 0
	}
}
