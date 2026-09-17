import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 绑定请求的签名与校验（绑定文档 §7）。
 *
 * 接入方用自己的 Ed25519 私钥签一次绑定请求，代表自己的账号绑定一个手机号。本站只存公钥，
 * 因此**能签得出通过验证的签名就等于持有私钥**——这是整条链的信任根。
 *
 * **身份就是公钥本身，同 GitHub 的 SSH。** 请求头里带着公钥，服务端据此反查出是哪个接入方、
 * 归属哪个账号——调用方不必再填 `client_id`、`kid`、`base_user_id` 三个值，也就不会填错。
 *
 * 有人会问：公钥是调用方自己给的，那换一把不就冒充了？换不了。**换成谁的公钥，就得拿谁的
 * 私钥来签**——而私钥从不出签发方的门。拿自己的公钥来签，反查到的就是自己的账号，什么也
 * 越不了权；拿别人的公钥来签，第一步验签就过不去。
 *
 * **签名方式与推送方向（SMS → 接入方，见 push.mts）对称，只是反过来**：签名放请求头，
 * 请求体是原样发出去的 JSON，不包一层。两个方向一套心智模型——接入方验证收到的推送时
 * 用的是这一套，签自己的绑定请求用的还是这一套，不用改用两套完全不同的做法。
 *
 * ```http
 * POST /api/client/phone-bind
 * X-Sms-Public-Key: <你登记的公钥>
 * X-Sms-Timestamp: <Unix 秒>
 * X-Sms-Nonce: <高熵随机串>
 * X-Sms-Signature: ed25519=<对 "timestamp.请求体原始字节" 的签名>
 *
 * {"phone":"+8613800138000","key":"order-8842","client_ref":"order-8842","title":"客户的机器"}
 * ```
 *
 * **请求体是普通 JSON，没有"这个字段该不该签"的判断**——整个请求体（原始字节，未经
 * 任何重新序列化）都是签名的一部分，随便加什么业务字段都天然被签了进去。
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

/** 四个请求头，从 Hono 的 `c.req.header()` 原样取出即可，不做任何预处理。 */
export type TicketHeaders = { publicKey: string; timestamp: string; nonce: string; signature: string };

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
 * 请求新鲜度容差 60 秒。**不再有调用方声明的有效期**——推送方向早就是这么做的
 * （`x-sms-timestamp` 只判新鲜度，不带一个独立的过期时间字段），这里改成同一套：时间戳
 * 不在这个窗口内就拒绝，窗口大小由本站定，不给接入方"签一个十年有效"的空间。
 */
const CLOCK_SKEW_SECONDS = 60;

/** 32 字节 Ed25519 公钥的 Base64URL 表示，43 个字符（不含补位的 =）。 */
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;

/**
 * 验一次绑定请求。
 *
 * **失败一律是确定性错误**（§7.2），不把内部异常冒出去：接入方拿到「绑定请求签名无效」
 * 能去查自己的私钥，拿到一段堆栈只能去提工单。
 *
 * 顺序有讲究：先查头部格式、再按公钥查身份、最后验签、验完签才解析请求体当 JSON 用。
 * 反过来先验签的话，公钥没登记时得先编一个身份出来才验得动；先解析 JSON 的话，一个
 * 签名对不上的请求也会被当成合法请求解析——解析本身不是权限判定，但没必要在验证通过
 * 之前多做这一步。
 */
export const verifyBindingTicket = async (database: DatabaseAdapter, headers: TicketHeaders, rawBody: string): Promise<TicketResult> => {
	const fail = (status: number, message: string): TicketResult => ({ ok: false, failure: { status, message } });

	const publicKey = String(headers.publicKey ?? '').trim();
	if (!publicKey) return fail(400, '缺少 X-Sms-Public-Key 请求头');
	if (!publicKeyPattern.test(publicKey)) return fail(400, 'X-Sms-Public-Key 必须是 Ed25519 原始字节的 Base64URL，43 个字符');

	const nonce = String(headers.nonce ?? '').trim();
	if (!nonce) return fail(400, '缺少 X-Sms-Nonce 请求头');

	const timestampRaw = String(headers.timestamp ?? '').trim();
	const timestamp = Number(timestampRaw);
	if (!timestampRaw || !Number.isFinite(timestamp)) return fail(400, 'X-Sms-Timestamp 请求头缺失或格式不对，应为 Unix 秒');
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > CLOCK_SKEW_SECONDS) return fail(400, '绑定请求已过期或尚未生效：X-Sms-Timestamp 与服务器时间相差超过 60 秒');

	const signatureHeader = String(headers.signature ?? '').trim();
	/**
	 * 老协议把这一切塞进请求体里一个叫 `ticket` 的字段。照着旧文档写的代码打过来，多半
	 * 是完全不带这四个头——直接落进下面这条判断，缺失了哪个头说得很直白，不需要专门再
	 * 识别一次"这看起来像老格式"：那反而要多解析一次请求体，为一个不会真正发生的窄场景
	 * （发对了 `ed25519=` 前缀却是空签名）徒增代码。
	 */
	if (!signatureHeader.startsWith('ed25519=')) return fail(400, 'X-Sms-Signature 请求头缺失或格式不对，应为 ed25519=<签名>');
	const signaturePart = signatureHeader.slice('ed25519='.length);
	if (!signaturePart) return fail(400, 'X-Sms-Signature 请求头缺失或格式不对，应为 ed25519=<签名>');

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
		// **验的是 "timestamp.请求体原始字节"**，不是重新序列化一遍的 JSON：键序或空格
		// 差一点就验不过。与推送方向（push.mts 的 attemptDelivery）签名输入同一个形状。
		const signedInput = new TextEncoder().encode(`${timestampRaw}.${rawBody}`);
		verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signaturePart), signedInput);
	} catch { verified = false; }
	if (!verified) return fail(401, '绑定请求签名无效：签的字节和发出去的请求体必须是同一串');

	let body: TicketBody;
	try { body = JSON.parse(rawBody) as TicketBody; } catch { return fail(400, '请求体不是合法 JSON'); }

	return {
		ok: true,
		clientRowId: String(client.id),
		ownerUid: String(client.owner_uid),
		phone: String(body.phone ?? ''),
		nonce,
		expiresAt: timestamp + CLOCK_SKEW_SECONDS,
		key: String(body.key ?? '').trim(),
		clientRef: String(body.client_ref ?? ''),
		title: String(body.title ?? ''),
		filename: String(body.filename ?? ''),
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
