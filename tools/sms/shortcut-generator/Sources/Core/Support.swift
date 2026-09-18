import Foundation
import CryptoKit
import Security

// 错误类型与小工具。CLI 与 GUI 共用这一份。

enum GenError: Error, CustomStringConvertible {
	case http(Int, String), sign(String), parse(String), random

	var description: String {
		switch self {
		case .http(let code, let message): return "HTTP \(code): \(message)"
		case .sign(let message):           return "签名失败: \(message)"
		case .parse(let message):          return "解析失败: \(message)"
		case .random:                      return "安全随机源不可用"
		}
	}
}

func sha256Hex(_ data: Data) -> String {
	SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// 32 字节系统安全随机 → Base64URL。
///
/// **随机源失败必须抛错，不能吞掉。** 吞掉之后拿到的是一段全零字节，它会照常被签进 Shortcut、
/// 照常上传入库，一切看起来正常——直到有人发现所有令牌都一样。
func randomTokenBase64URL() throws -> String {
	var bytes = [UInt8](repeating: 0, count: 32)
	guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw GenError.random }
	return Data(bytes).base64EncodedString()
		.replacingOccurrences(of: "+", with: "-")
		.replacingOccurrences(of: "/", with: "_")
		.replacingOccurrences(of: "=", with: "")
}

/// 原始令牌的 SHA-256：对写进 Shortcut 的 Bearer 字符串取摘要，接收端据此比对。
///
/// **口径尚未端到端确认**（见 README「已知缺口」）：若服务端按原始随机字节而不是 Base64URL
/// 字符串取摘要，改这一处即可。
func tokenSha256(_ token: String) -> String { sha256Hex(Data(token.utf8)) }

/// 按顺序取第一个非空字符串字段。服务端字段名在联调期间有过几种写法，这里对常见命名容错。
func firstString(_ object: [String: Any], _ keys: [String]) -> String? {
	for key in keys { if let value = object[key] as? String, !value.isEmpty { return value } }
	return nil
}
