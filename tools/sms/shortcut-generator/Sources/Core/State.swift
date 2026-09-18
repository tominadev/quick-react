import Foundation

// 断点续传用的本地状态文件（需求文档 §5.5）。
//
// **原始令牌和 token_sha256 一律不进状态文件、日志和清单。** 因此未完成的条目无法从已签名文件
// 里恢复出令牌——只能重做；而 commit 成功之前服务端没有任何记录，重做是安全的。
// 反过来，commit 成功之前也不能删本地签名文件：它是那个令牌唯一的副本。

struct Item: Codable {
	var idempotency_token: String
	var stage: String          // generated | uploaded | committed
	var local_path: String?
	var object_key: String?
	var token_id: String?
}

struct State: Codable {
	var task_id: String
	var items: [String: Item]  // key = 批次内序号
}

final class StateStore {
	let path: String
	var state: State

	init(path: String, taskID: String? = nil) {
		self.path = path
		if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
		   let decoded = try? JSONDecoder().decode(State.self, from: data) {
			state = decoded
		} else {
			state = State(task_id: taskID ?? UUID().uuidString, items: [:])
		}
	}

	func save() {
		guard let data = try? JSONEncoder().encode(state) else { return }
		try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
	}

	func startNewBatch() {
		state = State(task_id: UUID().uuidString, items: [:])
		save()
	}
}
