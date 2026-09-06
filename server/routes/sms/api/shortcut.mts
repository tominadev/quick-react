import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { firstSql, sql } from '@server/database/sql.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';

/**
 * iOS Shortcut 的门。**这一层验完凭证，叶子只管业务。**
 *
 * **为什么这一类用静态令牌，而不是和别处一样用签名**：iOS Shortcut 做不了 Ed25519 签名，
 * 只能把一个长期有效的 Bearer 令牌烤进 `.shortcut` 文件里带走。这是被客户端能力逼出来的
 * 妥协，不是首选——静态令牌长期有效，泄露只能靠撤销止血，而签名票据是一次性的、私钥根本
 * 不出签发方的门。
 *
 * 所以这个前缀标的是**客户端的能力边界**，不是终端类型。将来若有能签名的客户端要接进来，
 * 它该走签名那条路，而不是在这里再加一个终端；把它塞进来等于让一个本可以更安全的调用方
 * 降级到静态令牌。
 *
 * **只有这一层熔断，一处完成全部验证**：拒 cookie、取 Bearer、算摘要、查令牌、查手机状态、
 * 解析出主体。不拆成两级——每一级目录中间件都是每个请求都要走的一次调用，而拆开的唯一好处
 * 是「将来别的客户端也走静态令牌时能复用上半截」，那一天真来了再拆。
 *
 * 叶子拿到 `protocolSubject` 直接用，不再碰凭证，也就没有「忘了验」这种可能。
 */

/**
 * 恒时比较两个等长十六进制串。
 *
 * 按 SHA-256 查表本身已是等值匹配，攻击者无从按字节试探；但查到之后仍然比一次，且比得恒时——
 * 将来若有人把这里改成「先按前缀查再比对」，这一步就是最后一道防线，而按字节短路的比较会把
 * 「猜对了几位」通过耗时泄露出去。
 */
const timingSafeEqual = (left: string, right: string) => {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return diff === 0;
};

const handler: ApiHandler = async (c, next) => {
	/**
	 * 不接受 cookie 认证。浏览器会对跨站请求自动附带 cookie；这里若也认会话，任何网页都能
	 * 借用户已登录的身份往这些接口打。协议接口的身份跟随请求，不跟随浏览器。
	 */
	if (c.req.header('cookie')) return apiMessage(c, 400, '协议接口不接受 cookie 认证，请改用 Authorization 头');
	const authorization = (c.req.header('authorization') ?? '').trim();
	if (!/^Bearer\s+\S/i.test(authorization)) return apiMessage(c, 401, '缺少 Authorization: Bearer 凭证');
	const database = c.get('database');
	const token = authorization.replace(/^Bearer\s+/i, '').trim();
	/**
	 * 失败一律回同一句话、同一个状态。
	 *
	 * 令牌对不对、手机停没停用、是不是已解绑，对调用方来说都是「这台设备现在不能提交」。
	 * 逐一告知等于白送一个区分器：拿一个偷来的令牌就能测出它是被撤销了还是手机被停用了。
	 */
	const refuse = () => apiMessage(c, 401, '设备不可用或凭证无效');

	const digest = await sha256(token);
	const found = await firstSql<{ token_sha256: string; phone_id: string | null; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_shortcut_tokens',
		columns: { token_sha256: 'token_sha256', phone_id: { column: 'phone_id', cast: 'text' }, status: 'status' },
		where: [{ column: 'token_sha256', value: digest }],
		limit: 1,
	}));
	if (!found || !timingSafeEqual(String(found.token_sha256), digest)) return refuse();
	if (found.status !== 'bound' || !found.phone_id) return refuse();

	const phone = await firstSql<{ id: string; owner_uid: string | null; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones',
		columns: { id: { column: 'id', cast: 'text' }, owner_uid: { column: 'owner_uid', cast: 'text' }, status: 'status' },
		where: [{ column: 'id', value: found.phone_id }],
		limit: 1,
	}));
	if (!phone || phone.status !== 'enabled' || !phone.owner_uid) return refuse();

	// 主体交给叶子：谁的、哪一台。叶子不再碰凭证，也就没有「忘了验」这种可能。
	c.set('protocolSubject', { kind: 'token', ownerUid: String(phone.owner_uid), deviceId: String(phone.id) });
	return next();
};

export default handler;
