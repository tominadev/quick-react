import Foundation

// SMS 平台的生成器接口：config → prepare-upload → PUT → commit（需求文档 §5）。
// 本工具不连接任何数据库；令牌只存在于 Shortcut 文件和用户手机里。

struct Client {
	let config: Config

	private func request(_ action: String, method: String, json: [String: Any]? = nil) async throws -> [String: Any] {
		var components = URLComponents(url: config.endpoint, resolvingAgainstBaseURL: false)!
		components.queryItems = [URLQueryItem(name: "action", value: action)]
		var request = URLRequest(url: components.url!)
		request.httpMethod = method
		request.timeoutInterval = 30
		request.setValue("Bearer \(config.provisioningKey)", forHTTPHeaderField: "Authorization")
		if let json {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try JSONSerialization.data(withJSONObject: json)
		}
		let (data, response) = try await URLSession.shared.data(for: request)
		let code = (response as? HTTPURLResponse)?.statusCode ?? 0
		let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
		guard (200..<300).contains(code) else {
			let message = ((object["feedback"] as? [String: Any])?["message"] as? String) ?? String(data: data, encoding: .utf8) ?? ""
			throw GenError.http(code, message)
		}
		return object
	}

	/// §5.2 拉接收地址（生成前必须现取当前值）；§5.2.1 顺带取池子余量。
	func fetchConfig() async throws -> (receiveURL: String, machine: String, available: Int) {
		let object = try await request("config", method: "GET")
		guard let url = object["message_receive_url"] as? String, !url.isEmpty else {
			throw GenError.parse("config 未返回 message_receive_url")
		}
		let pool = object["pool"] as? [String: Any]
		let available = (pool?["available"] as? NSNumber)?.intValue ?? (pool?["available"] as? Int) ?? 0
		return (url, (object["machine"] as? String) ?? "", available)
	}

	/// §5.4 一：申请上传票据。无状态，不带 `token_sha256`。
	func prepareUpload(idempotencyToken: String, fileSha: String, size: Int) async throws -> (ticket: String?, objectKey: String, putURL: String) {
		let object = try await request("prepare-upload", method: "POST", json: [
			"idempotency_token": idempotencyToken, "file_sha256": fileSha, "size_bytes": size,
		])
		guard let putURL = firstString(object, ["put_url", "upload_url", "presigned_url", "url"]),
		      let objectKey = firstString(object, ["object_key", "key"]) else {
			throw GenError.parse("prepare-upload 响应缺少 PUT 地址或对象键: \(object.keys.sorted())")
		}
		return (firstString(object, ["upload_ticket", "ticket"]), objectKey, putURL)
	}

	/// §5.4 二：预签名 PUT，把文件传进私有对象存储。
	func put(_ url: String, file: URL) async throws {
		guard let target = URL(string: url) else { throw GenError.parse("非法 PUT 地址") }
		var request = URLRequest(url: target)
		request.httpMethod = "PUT"
		request.timeoutInterval = 60
		request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
		request.httpBody = try Data(contentsOf: file)
		let (_, response) = try await URLSession.shared.data(for: request)
		let code = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(code) else { throw GenError.http(code, "PUT 上传失败") }
	}

	/// §5.4 三：提交入库，返回 `token_id`。
	func commit(idempotencyToken: String, ticket: String?, objectKey: String, tokenSha: String, fileSha: String, size: Int) async throws -> String {
		var body: [String: Any] = [
			"idempotency_token": idempotencyToken, "object_key": objectKey,
			"token_sha256": tokenSha, "file_sha256": fileSha, "size_bytes": size,
		]
		if let ticket { body["upload_ticket"] = ticket }
		return firstString(try await request("commit", method: "POST", json: body), ["token_id", "id"]) ?? ""
	}

	func abort(idempotencyToken: String, objectKey: String?) async {
		var body: [String: Any] = ["idempotency_token": idempotencyToken]
		if let objectKey { body["object_key"] = objectKey }
		_ = try? await request("abort", method: "POST", json: body)
	}
}
