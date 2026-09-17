import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 绑定请求的签名与校验（绑定文档 §7）。
 *
 * 接入方用自己的 Ed25519 私钥签一次绑定请求，代表自己的账号绑定一个手机号。本站只存公钥，
 * 因此**能签得出通过验证的签名就等于持有私钥**——这是整条链的信任根。
 *
 * **身份就是公钥本身，同 GitHub 的 SSH。** 请求里带着公钥，服务端据此反查出是哪个接入方、
 * 归属哪个账号——调用方不必再填 `client_id`、`kid`、`base_user_id` 三个值，也就不会填错。
 *
 * 有人会问：公钥是调用方自己给的，那换一把不就冒充了？换不了。**换成谁的公钥，就得拿谁的
 * 私钥来签**——而私钥从不出签发方的门。拿自己的公钥来签，反查到的就是自己的账号，什么也
 * 越不了权；拿别人的公钥来签，第一步验签就过不去。
 *
 * ## 请求长这样
 *
 * ```http
 * POST /api/client/phone-bind
 * Content-Type: text/plain
 *
 * {"publicKey":"…","signature":"ed25519=…","payload":"{\"ts\":1789666485,\"nonce\":\"…\",\"phone\":\"+8613800138000\"}"}
 * ```
 *
 * **`payload` 是一段 JSON 字符串，不是嵌套对象。** 签的就是这段字符串的 UTF-8 原始字节——
 * 原样收、原样验，中间不经过任何解析与重新序列化。键序、空格、Unicode 转义怎么发的就怎么
 * 验，两边不必约定同一套序列化规则（那是 JSON 签名最常见的踩坑处）。
 *
 * ## 为什么把一切塞进一个信封，而不是放请求头
 *
 * **为了让浏览器把它当成 CORS 简单请求发出去。** 自定义请求头（`X-Sms-*`）会让浏览器先发
 * 一次 `OPTIONS` 预检，而预检失败时接入方在控制台只看得到一句 CORS 错误、服务端日志里一片
 * 空白——最难查的一类问题。改成 `Content-Type: text/plain` 加一个没有自定义头的请求体之后，
 * 预检根本不会发生，服务端只要在响应上带 `Access-Control-Allow-Origin` 就够了。
 *
 * **`ts` 与 `nonce` 因此进了签名范围。** 它们原先是请求头，而签名只覆盖
 * `"时间戳.请求体"`——`nonce` 一个字节都没被签进去，改一改签名照样通得过。现在它们和业务
 * 字段一样待在 `payload` 里，改任何一个字符签名都会当场失效。
 */
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
};

/** 请求体里能带的业务字段，全都可选。`key`/`client_ref` 的格式与长度校验在 binding.mts。 */
export type TicketBody = {
	phone?: string;
	/** 接入方自己指定的行标识，驱动去重；不传就照常按号码去重。 */
	key?: string;
	/** 接入方自己的引用串，推送时原样带回；不参与去重。 */
	client_ref?: string;
	/** 给手机起的名字。 */
	title?: string;
	/**
	 * 快捷指令下载下来叫什么名字，可选。
	 *
	 * 不传就按接入方标题加号码后四位推导。传了会**存在这一行上**，之后无论第几次要下载地址
	 * 都是同一个名字；后缀强制 `.shortcut`，iOS 靠它决定用「快捷指令」打开。
	 */
	filename?: string;
};

/** 信封：三个字段，`payload` 是一段 JSON **字符串**。 */
export type TicketEnvelope = { publicKey?: unknown; signature?: unknown; payload?: unknown };

/** `payload` 解出来之后的内容。业务字段全都可选；`ts` 与 `nonce` 必填，它们是防重放的那一半。 */
export type TicketPayload = TicketBody & {
	/** Unix 秒。与服务器时间相差超过 60 秒就拒绝。 */
	ts?: unknown;
	/** 高熵随机串，一次性。消费过的不能再用。 */
	nonce?: unknown;
};

export type TicketFailure = { status: number; message: string };
export type TicketResult =
	| { ok: false; failure: TicketFailure }
	| {
		ok: true;
		/** 这把公钥属于哪个接入方，以及那个接入方属于谁——两个值都由服务端查出来，不由调用方给。 */
		clientRowId: string;
		ownerUid: string;
		phone: string;
		nonce: string;
		/** nonce 记录的清理时限，见 consumeTicketNonce——不再由调用方声明过期时间，由本站固定窗口推算。 */
		expiresAt: number;
		/** 原样带出，未做格式校验——那是调用方（binding.mts）的事，这里只管验签。 */
		key: string;
		clientRef: string;
		title: string;
		filename: string;
	};

/**
 * 查不到可用公钥时的统一回话。
 *
 * 这里没有枚举风险——公钥是 32 字节随机值，猜不出来，所以话可以说得很直白：能拿到一把
 * 公钥的人，本来就知道这把公钥长什么样。
 */
const unknownKeyMessage = '这把公钥没有登记，或者已经退役——到控制台「接入方公钥」里登记一把';

/**
 * 请求新鲜度容差 60 秒。**不接受调用方声明的有效期**——窗口大小由本站定，不给接入方
 * 「签一个十年有效」的空间。
 */
const CLOCK_SKEW_SECONDS = 60;

/** 32 字节 Ed25519 公钥的 Base64URL 表示，43 个字符（不含补位的 =）。 */
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * 验一次绑定请求。传进来的是**请求体原始字符串**，这一层自己拆信封。
 *
 * **失败一律是确定性错误**（§7.2），不把内部异常冒出去：接入方拿到「绑定请求签名无效」
 * 能去查自己的私钥，拿到一段堆栈只能去提工单。
 *
 * 顺序有讲究：拆信封 → 查格式 → 按公钥查身份 → **验签** → 验完签才解析 `payload`。
 * `payload` 在验签之前只是一串待验的字节，不该被当成结构化内容读；时间戳与 nonce 也因此
 * 排在验签之后——它们本来就在 `payload` 里，提前读就等于信了还没验过的东西。
 */
export const verifyBindingTicket = async (database: DatabaseAdapter, rawBody: string): Promise<TicketResult> => {
	const fail = (status: number, message: string): TicketResult => ({ ok: false, failure: { status, message } });

	let envelope: TicketEnvelope;
	try { envelope = JSON.parse(rawBody) as TicketEnvelope; } catch { return fail(400, '请求体不是合法 JSON：应为 {"publicKey":…,"signature":…,"payload":…} 三个字段'); }
	if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail(400, '请求体不是合法 JSON：应为 {"publicKey":…,"signature":…,"payload":…} 三个字段');

	const publicKey = text(envelope.publicKey);
	if (!publicKey) return fail(400, '缺少 publicKey');
	if (!publicKeyPattern.test(publicKey)) return fail(400, 'publicKey 必须是 Ed25519 原始字节的 Base64URL，43 个字符');

	const signatureValue = text(envelope.signature);
	if (!signatureValue.startsWith('ed25519=')) return fail(400, 'signature 缺失或格式不对，应为 ed25519=<签名>');
	const signaturePart = signatureValue.slice('ed25519='.length);
	if (!signaturePart) return fail(400, 'signature 缺失或格式不对，应为 ed25519=<签名>');

	/**
	 * **`payload` 必须是字符串，不接受对象。**
	 *
	 * 传成嵌套对象的话，要验签就得先把它序列化回字符串，而那一步两边不可能保证一致——
	 * 键序、空格、Unicode 转义任何一点不同，签名就对不上，而报出来的错是「签名无效」，
	 * 看的人会去查私钥，查不到真正的原因。所以这里把话说死在最前面。
	 */
	if (typeof envelope.payload !== 'string') return fail(400, 'payload 必须是一段 JSON 字符串，不是嵌套对象——签的就是这段字符串本身');
	const payloadText = envelope.payload;
	if (!payloadText) return fail(400, 'payload 不能为空');

	/**
	 * **公钥反查身份。** `public_key` 全库唯一，因此这一查就定死了是哪个接入方；接入方的
	 * `owner_uid` 就是手机要登记到的账号。
	 *
	 * `retired` 的公钥立即拒绝新请求（§4.2）——轮换的意义就在这一句。
	 */
	const keyRow = await firstSql<{ integration_client_id: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_client_keys',
		columns: { integration_client_id: { column: 'integration_client_id', cast: 'text' }, status: 'status' },
		where: [{ column: 'public_key', value: publicKey }], limit: 1,
	}));
	if (!keyRow || keyRow.status !== 'active') return fail(401, unknownKeyMessage);

	const client = await firstSql<{ id: string; owner_uid: string | null; status: string; binding_scope: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_clients',
		columns: { id: { column: 'id', cast: 'text' }, owner_uid: { column: 'owner_uid', cast: 'text' }, status: 'status', binding_scope: 'binding_scope' },
		where: [{ column: 'id', value: keyRow.integration_client_id }], limit: 1,
	}));
	if (!client || client.status !== 'enabled') return fail(401, '这把公钥所属的接入方已停用');
	if (!client.owner_uid) return fail(401, '这把公钥所属的接入方没有归属账号，请在控制台重新登记');
	if (!String(client.binding_scope ?? '').split(',').map((item) => item.trim()).includes('phone:bind')) return fail(403, '这个接入方没有绑定手机的权限');

	let verified = false;
	try {
		const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'Ed25519' }, false, ['verify']);
		// **验的就是 payload 这段字符串的 UTF-8 字节**，原样取自信封，不重新序列化。
		// 与推送方向（push.mts 的 attemptDelivery）同一个心智：签什么就发什么，发什么就验什么。
		verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signaturePart), new TextEncoder().encode(payloadText));
	} catch { verified = false; }
	if (!verified) return fail(401, '绑定请求签名无效：签的必须是 payload 这段字符串本身的字节');

	let payload: TicketPayload;
	try { payload = JSON.parse(payloadText) as TicketPayload; } catch { return fail(400, 'payload 不是合法 JSON'); }
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'payload 不是合法 JSON 对象');

	const nonce = text(payload.nonce);
	if (!nonce) return fail(400, 'payload 里缺少 nonce');

	const timestamp = Number(payload.ts);
	if (payload.ts === undefined || payload.ts === null || !Number.isFinite(timestamp)) return fail(400, 'payload 里的 ts 缺失或格式不对，应为 Unix 秒');
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > CLOCK_SKEW_SECONDS) return fail(400, `绑定请求已过期或尚未生效：ts 与服务器时间相差超过 ${CLOCK_SKEW_SECONDS} 秒`);

	return {
		ok: true,
		clientRowId: String(client.id),
		ownerUid: String(client.owner_uid),
		phone: String(payload.phone ?? ''),
		nonce,
		expiresAt: timestamp + CLOCK_SKEW_SECONDS,
		key: String(payload.key ?? '').trim(),
		clientRef: String(payload.client_ref ?? ''),
		title: String(payload.title ?? ''),
		filename: String(payload.filename ?? ''),
	};
};

/**
 * 消费 nonce。**这一步必须在绑定之前**（§6.2 第 5 步）。
 *
 * nonce 一旦消费成功，这次请求即作废；后续步骤失败时接入方要重新签一次，而不是能用同一个
 * nonce 重试。反过来（先绑定后消费）在无事务环境下会留下「绑定成功但 nonce 未消费」——那
 * 意味着同一个签名还能再用一次，比「消费了但没绑成」糟得多。
 *
 * 靠 `(integration_client_id, nonce)` 的唯一约束加 `ignoreInsert`，影响行数为 0 就是用过了。
 */
export const consumeTicketNonce = async (database: DatabaseAdapter, clientRowId: string, nonce: string, expiresAt: number) => {
	const result = await runSql(database, sql({ database, subjectRoles: null }).ignoreInsert('sms_ticket_nonces', ['integration_client_id', 'nonce'], {
		integration_client_id: clientRowId, nonce, expires_at: expiresAt * 1000,
	}));
	return Number(result.meta?.changes ?? 0) > 0;
};
