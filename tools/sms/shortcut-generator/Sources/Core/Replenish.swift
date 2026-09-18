import Foundation

// 补货：把池子补到「目标可用数量」（需求文档 §5.2.1）。
//
// `--count` 是**目标可用数量**，不是新增数量：先拉 config 取 pool.available，只生成
// max(0, 目标 − 可用) 个。服务端删了或回收了令牌导致可用数下降后，再跑一次就自动补回目标数。
//
// 两个前端共用这一份：日志走 `log` 回调（CLI 写 stderr，GUI 追加到窗口），停止走 `isCancelled`
// 回调（CLI 恒为 false，GUI 是「停止」按钮）。Core 不调用 exit()。

enum ItemOutcome { case ok, failed, signBroken(String) }   // signBroken = 环境问题，必然影响全部
enum CycleOutcome { case ok, hadFailures, cancelled, signBroken(String) }

/// 单个令牌的完整流程：生成 → 签名 → prepare-upload → PUT → commit。
///
/// 已 committed 的直接跳过；没做完的一律重新生成（原因见 State.swift）。
func processOne(seq: Int, store: StateStore, client: Client, template: String, receiveURL: String,
                workDir: URL, keepLocal: Bool, log: (String) -> Void) async -> ItemOutcome {
	let key = String(seq)
	if let item = store.state.items[key], item.stage == "committed" {
		log("  已完成 token_id=\(item.token_id ?? "?")")
		return .ok
	}
	let idempotencyToken = "\(store.state.task_id):\(seq)"
	let tag = idempotencyToken.replacingOccurrences(of: ":", with: "_")
	do {
		let token = try randomTokenBase64URL()                                    // §5.3
		let tokenSha = tokenSha256(token)
		let signed = try buildAndSign(template: template, receiveURL: receiveURL, token: token, workDir: workDir, tag: tag)
		let localPath = workDir.appendingPathComponent("\(tag).shortcut")
		try signed.write(to: localPath)
		let fileSha = sha256Hex(signed)
		let size = signed.count
		store.state.items[key] = Item(idempotency_token: idempotencyToken, stage: "generated",
		                              local_path: localPath.path, object_key: nil, token_id: nil)
		store.save()

		let (ticket, objectKey, putURL) = try await client.prepareUpload(idempotencyToken: idempotencyToken, fileSha: fileSha, size: size)  // §5.4 一
		store.state.items[key]?.object_key = objectKey
		store.save()

		try await client.put(putURL, file: localPath)                             // §5.4 二
		store.state.items[key]?.stage = "uploaded"
		store.save()

		let tokenID = try await client.commit(idempotencyToken: idempotencyToken, ticket: ticket, objectKey: objectKey,
		                                      tokenSha: tokenSha, fileSha: fileSha, size: size)                                            // §5.4 三
		store.state.items[key]?.stage = "committed"
		store.state.items[key]?.token_id = tokenID
		store.save()

		if !keepLocal { try? FileManager.default.removeItem(at: localPath) }       // §5.6
		log("  OK  token_id=\(tokenID)  对象路径=\(objectKey)")
		return .ok
	} catch let error as GenError {
		if case .sign(let message) = error { return .signBroken(message) }         // 环境问题，交给上层中止
		log("  失败: \(error)")
		if let objectKey = store.state.items[key]?.object_key { await client.abort(idempotencyToken: idempotencyToken, objectKey: objectKey) }
		return .failed
	} catch {
		log("  失败: \(error)")
		if let objectKey = store.state.items[key]?.object_key { await client.abort(idempotencyToken: idempotencyToken, objectKey: objectKey) }
		return .failed
	}
}

/// 一轮补货。顺序是固定的：先续完上批没做完的，再重新取余量，再用新批次生成差额。
func replenishOnce(client: Client, template: String, target: Int, store: StateStore, keepLocal: Bool,
                   log: (String) -> Void, isCancelled: () -> Bool) async -> CycleOutcome {
	let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("sms-gen-run-\(UUID().uuidString)")
	try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
	defer { try? FileManager.default.removeItem(at: workDir) }

	var receiveURL = "", machine = "", available = 0
	do { (receiveURL, machine, available) = try await client.fetchConfig() }       // §5.2
	catch { log("config 失败: \(error)"); return .hadFailures }
	log("机器 name=\(machine)  当前可用 \(available)  目标 \(target)")

	var succeeded = 0, failed = 0

	// 步骤 1：先续完状态文件里没做完的。顺序要紧——续完的要算进后面那次余量里。
	let incomplete = store.state.items.filter { $0.value.stage != "committed" }.keys.compactMap(Int.init).sorted()
	if !incomplete.isEmpty {
		log("续完上批未完成 \(incomplete.count) 个 …")
		for seq in incomplete {
			if isCancelled() { log("已停止（本轮完成 \(succeeded) 个）"); return .cancelled }
			switch await processOne(seq: seq, store: store, client: client, template: template,
			                        receiveURL: receiveURL, workDir: workDir, keepLocal: keepLocal, log: log) {
			case .ok: succeeded += 1
			case .failed: failed += 1
			case .signBroken(let message): return .signBroken(message)
			}
		}
		// 步骤 2：续完之后余量变了，重新取。
		do { (receiveURL, machine, available) = try await client.fetchConfig() }
		catch { log("config 失败: \(error)"); return .hadFailures }
		log("续完后当前可用 \(available)")
	}

	// 步骤 3：目标 − 可用。
	let toGenerate = max(0, target - available)
	if toGenerate == 0 {
		log("已有 \(available) 个可用，达到目标 \(target)，无需生成")
		return failed == 0 ? .ok : .hadFailures
	}
	log("需生成 \(toGenerate) 个（目标 \(target) − 可用 \(available)）")

	// 步骤 4：开新批次生成差额。
	store.startNewBatch()
	log("新批次 task_id=\(store.state.task_id)")
	for seq in 1...toGenerate {
		if isCancelled() { log("已停止（本轮完成 \(succeeded) 个）"); return .cancelled }
		log("[\(seq)/\(toGenerate)]")
		switch await processOne(seq: seq, store: store, client: client, template: template,
		                        receiveURL: receiveURL, workDir: workDir, keepLocal: keepLocal, log: log) {
		case .ok: succeeded += 1
		case .failed: failed += 1
		case .signBroken(let message): return .signBroken(message)   // 立刻中止，别硬撑剩下的
		}
	}
	log("本轮完成: 成功 \(succeeded)，失败 \(failed)")
	return failed == 0 ? .ok : .hadFailures
}
