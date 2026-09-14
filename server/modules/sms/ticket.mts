import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 绑定票据的解析与校验（绑定文档 §7）。
 *
 * 接入方用自己的 Ed25519 私钥签一张一次性票据，代表某个用户绑定一个手机号。本站只存公钥，
 * 因此**能签票据就等于持有私钥**——这是整条链的信任根。
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
	client_id?: string;
	kid?: string;
	base_user_id?: string;
	phone?: string;
	iat?: number;
	exp?: number;
	nonce?: string;
};

export type TicketFailure = { status: number; message: string };
export type TicketResult =
	| { ok: false; failure: TicketFailure }
	| { ok: true; payload: TicketPayload & { client_id: string; base_user_id: string; phone: string; nonce: string }; clientRowId: string };

/**
 * 查不到可用公钥时的统一回话。四种成因共用它，理由见下面查 client 那一段。
 *
 * `client_id` 对应控制台「接入方」页的**标识**那一列，不是名称——这是对接时最常踩的一脚：
 * 照着文档示例填了 `shop`，而自己建的那个叫别的。
 */
const refuseMessage = '签名接入方无效：client_id 与 kid 没有匹配到一把启用中的公钥（client_id 是接入方的「标识」，不是名称）';

/** 有效期最长 5 分钟，允许 60 秒时钟偏差（§7.1）。 */
const MAX_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;

/**
 * 验一张票据。
 *
 * **失败一律是确定性错误**（§7.2），不把内部异常冒出去：接入方拿到「绑定票据签名无效」
 * 能去查自己的私钥，拿到一段堆栈只能去提工单。
 *
 * 顺序有讲究：先解析、再找公钥、最后验签。反过来先验签的话，`kid` 不存在时得先编一把
 * 公钥出来才验得动。
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
	const clientId = String(payload.client_id ?? '').trim();
	const kid = String(payload.kid ?? '').trim();
	const nonce = String(payload.nonce ?? '').trim();
	const baseUserId = String(payload.base_user_id ?? '').trim();
	if (!clientId || !kid || !nonce || !baseUserId) return fail(400, '绑定票据缺少必要字段');

	const now = Math.floor(Date.now() / 1000);
	const issuedAt = Number(payload.iat ?? 0);
	const expiresAt = Number(payload.exp ?? 0);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return fail(400, '绑定票据已过期或尚未生效');
	// 有效期上限由本站定，而不是随接入方填——不然签一张十年有效的票据就成了长期凭证。
	if (expiresAt - issuedAt > MAX_LIFETIME_SECONDS) return fail(400, '绑定票据有效期过长');
	if (now + CLOCK_SKEW_SECONDS < issuedAt || now - CLOCK_SKEW_SECONDS > expiresAt) return fail(400, '绑定票据已过期或尚未生效');

	/**
	 * `client_id` 对应 `sms_integration_clients.name`——**不是 `key`**：`key` 只装机器写的
	 * 雪花号，人给的标识一律落在 `name` 上。
	 */
	const client = await firstSql<{ id: string; owner_uid: string | null; status: string; binding_scope: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_clients',
		columns: { id: { column: 'id', cast: 'text' }, owner_uid: { column: 'owner_uid', cast: 'text' }, status: 'status', binding_scope: 'binding_scope' },
		where: [{ column: 'name', value: clientId }], limit: 1,
	}));
	/**
	 * 接入方不存在、已停用、kid 不存在、kid 已退役——**四种情况回同一句话**，因为验签发生在
	 * 这之后，此刻的调用方还是未经认证的：分开回答等于给了一个可以枚举「这个平台上有哪些
	 * 接入方」的探测器。
	 *
	 * 但话要说得能照着查：不点破是哪一个不对，只点明**该看哪两个字段**。不然接入方拿到一句
	 * 「无效」，手里有四个可能，只能一个个试。
	 */
	if (!client || client.status !== 'enabled') return fail(401, refuseMessage);
	if (!String(client.binding_scope ?? '').split(',').map((item) => item.trim()).includes('phone:bind')) return fail(403, '这个接入方没有绑定手机的权限');

	const keyRow = await firstSql<{ public_key: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_client_keys',
		columns: { public_key: 'public_key', status: 'status' },
		where: [{ column: 'integration_client_id', value: client.id }, { column: 'kid', value: kid }], limit: 1,
	}));
	// `retired` 的公钥立即拒绝新票据（§4.2）——轮换的意义就在这一句。
	if (!keyRow || keyRow.status !== 'active') return fail(401, refuseMessage);

	let verified = false;
	try {
		const key = await crypto.subtle.importKey('raw', fromBase64Url(String(keyRow.public_key)), { name: 'Ed25519' }, false, ['verify']);
		// **验的是票据里那串原始字节**，不是重新序列化一遍的 JSON：键序或空格差一点就验不过。
		verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signaturePart), payloadBytes);
	} catch { verified = false; }
	if (!verified) return fail(401, '绑定票据签名无效');

	return { ok: true, payload: { ...payload, client_id: clientId, base_user_id: baseUserId, phone: String(payload.phone ?? ''), nonce }, clientRowId: String(client.id) };
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
