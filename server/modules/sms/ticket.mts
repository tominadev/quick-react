import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 绑定票据的解析与校验（绑定文档 §7）。
 *
 * 接入方用自己的 Ed25519 私钥签一张一次性票据，代表自己的账号绑定一个手机号。本站只存公钥，
 * 因此**能签票据就等于持有私钥**——这是整条链的信任根。
 *
 * **身份就是公钥本身，同 GitHub 的 SSH。** 票据里带着公钥，服务端据此反查出是哪个接入方、
 * 归属哪个账号——调用方不必再填 `client_id`、`kid`、`base_user_id` 三个值，也就不会填错。
 *
 * 有人会问：公钥是调用方自己给的，那换一把不就冒充了？换不了。**换成谁的公钥，就得拿谁的
 * 私钥来签**——而私钥从不出签发方的门。拿自己的公钥来签，反查到的就是自己的账号，什么也
 * 越不了权；拿别人的公钥来签，第一步验签就过不去。
 */

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
};

export type TicketPayload = {
	v?: number;
	aud?: string;
	public_key?: string;
	phone?: string;
	iat?: number;
	exp?: number;
	nonce?: string;
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
		expiresAt: number;
	};

/**
 * 查不到可用公钥时的统一回话。
 *
 * 这里没有枚举风险——公钥是 32 字节随机值，猜不出来，所以话可以说得很直白：能拿到一把
 * 公钥的人，本来就知道这把公钥长什么样。
 */
const unknownKeyMessage = '这把公钥没有登记，或者已经退役——到控制台「接入方公钥」里登记一把';

/** 有效期最长 5 分钟，允许 60 秒时钟偏差（§7.1）。 */
const MAX_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;

/** 32 字节 Ed25519 公钥的 Base64URL 表示，43 个字符（不含补位的 =）。 */
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;

/**
 * 验一张票据。
 *
 * **失败一律是确定性错误**（§7.2），不把内部异常冒出去：接入方拿到「绑定票据签名无效」
 * 能去查自己的私钥，拿到一段堆栈只能去提工单。
 *
 * 顺序有讲究：先解析、再按公钥查身份、最后验签。反过来先验签的话，公钥没登记时得先编一个
 * 身份出来才验得动。
 */
export const verifyBindingTicket = async (database: DatabaseAdapter, ticket: string): Promise<TicketResult> => {
	const fail = (status: number, message: string): TicketResult => ({ ok: false, failure: { status, message } });
	const [payloadPart, signaturePart, ...rest] = String(ticket ?? '').trim().split('.');
	if (!payloadPart || !signaturePart || rest.length) return fail(400, '绑定票据格式不正确');

	let payload: TicketPayload;
	let payloadBytes: Uint8Array<ArrayBuffer>;
	try {
		payloadBytes = fromBase64Url(payloadPart);
		payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as TicketPayload;
	} catch { return fail(400, '绑定票据格式不正确'); }

	// aud 不是形式：没有它，一张签给别的系统的票据可以拿来换这里的绑定。
	if (payload.aud !== 'sms') return fail(400, '绑定票据受众不匹配');
	if (payload.v !== 1) return fail(400, '绑定票据版本不支持');
	const publicKey = String(payload.public_key ?? '').trim();
	const nonce = String(payload.nonce ?? '').trim();
	// 老协议用 client_id + kid 指认身份。照着旧文档写的代码撞上来时，说清改成了什么，
	// 省掉一轮「缺少必要字段」是指哪个字段的来回。
	if (!publicKey && (payload as { client_id?: unknown }).client_id) {
		return fail(400, '票据格式已简化：不再需要 client_id、kid、base_user_id，改成带一个 public_key 字段（值就是你登记的那把公钥）');
	}
	if (!publicKeyPattern.test(publicKey)) return fail(400, '票据里的 public_key 必须是 Ed25519 原始字节的 Base64URL，43 个字符');
	if (!nonce) return fail(400, '绑定票据缺少 nonce');

	const now = Math.floor(Date.now() / 1000);
	const issuedAt = Number(payload.iat ?? 0);
	const expiresAt = Number(payload.exp ?? 0);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return fail(400, '绑定票据已过期或尚未生效');
	// 有效期上限由本站定，而不是随接入方填——不然签一张十年有效的票据就成了长期凭证。
	if (expiresAt - issuedAt > MAX_LIFETIME_SECONDS) return fail(400, '绑定票据有效期过长：exp - iat 不得超过 300 秒');
	if (now + CLOCK_SKEW_SECONDS < issuedAt || now - CLOCK_SKEW_SECONDS > expiresAt) return fail(400, '绑定票据已过期或尚未生效');

	/**
	 * **公钥反查身份。** `public_key` 全库唯一，因此这一查就定死了是哪个接入方；接入方的
	 * `owner_uid` 就是手机要登记到的账号。
	 *
	 * `retired` 的公钥立即拒绝新票据（§4.2）——轮换的意义就在这一句。
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
		// **验的是票据里那串原始字节**，不是重新序列化一遍的 JSON：键序或空格差一点就验不过。
		verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signaturePart), payloadBytes);
	} catch { verified = false; }
	if (!verified) return fail(401, '绑定票据签名无效：签的字节和发出去的字节必须是同一串');

	return {
		ok: true,
		clientRowId: String(client.id),
		ownerUid: String(client.owner_uid),
		phone: String(payload.phone ?? ''),
		nonce,
		expiresAt,
	};
};

/**
 * 消费 nonce。**这一步必须在绑定之前**（§6.2 第 5 步）。
 *
 * nonce 一旦消费成功，票据即作废；后续步骤失败时接入方要重新签一张，而不是能用同一张
 * 重试。反过来（先绑定后消费）在无事务环境下会留下「绑定成功但 nonce 未消费」——那意味着
 * 同一张票据还能再绑一次，比「消费了但没绑成」糟得多。
 *
 * 靠 `(integration_client_id, nonce)` 的唯一约束加 `ignoreInsert`，影响行数为 0 就是用过了。
 */
export const consumeTicketNonce = async (database: DatabaseAdapter, clientRowId: string, nonce: string, expiresAt: number) => {
	const result = await runSql(database, sql({ database, subjectRoles: null }).ignoreInsert('sms_ticket_nonces', ['integration_client_id', 'nonce'], {
		integration_client_id: clientRowId, nonce, expires_at: expiresAt * 1000,
	}));
	return Number(result.meta?.changes ?? 0) > 0;
};
