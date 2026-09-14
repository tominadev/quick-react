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

type ReceiveTrace = { token?: { id: string; status: string; deleted: boolean }; phoneId?: string };

/**
 * **记下每一次提交到底收到了什么**，一行 JSON 写进服务日志（PM2 的 out 日志）。
 *
 * 为什么要有：快捷指令跑在别人手机上，出了问题服务端原来一点痕迹都不留——被拒的提交
 * 不入库，于是「收到短信却没写入」只能靠推断是自动化指向了旧快捷指令、还是读不到正文、
 * 还是压根没发过来。有了这一行，三种情况一眼分得清：没有日志就是没发过来。
 *
 * 记什么、不记什么：
 * - **原始令牌与它的摘要一概不记**，只记令牌在库里的编号与状态（生成器文档：摘要与令牌
 *   敏感级别相同）。
 * - **失败的记完整请求体**——那正是要查的；**成功的只记字段名与正文长度**，正文已经在
 *   短信表里，不必在日志文件里再存一份验证码。
 * - **认不出的令牌只记字段名与长度**：那可能是任何人发来的任何东西，照单全收等于让人
 *   往日志里随便写。
 */
const describeBody = (raw: string, detailed: boolean) => {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return detailed ? { raw: raw.slice(0, 2000), raw_length: raw.length } : { raw_length: raw.length, json: false };
	}
	const fields = parsed as Record<string, unknown>;
	if (detailed) return { body: JSON.parse(JSON.stringify(fields, (_key, value) => (typeof value === 'string' ? value.slice(0, 1000) : value))) };
	return {
		fields: Object.keys(fields),
		lengths: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? value.length : typeof value])),
	};
};

const recordReceive = async (c: Parameters<ApiHandler>[0], response: Response, raw: string, trace: ReceiveTrace) => {
	const message = await response.clone().json().then((json: { feedback?: { message?: string } }) => json?.feedback?.message).catch(() => undefined);
	const succeeded = response.status >= 200 && response.status < 300;
	console.log(`[sms-receive] ${JSON.stringify({
		at: new Date().toISOString(),
		path: new URL(c.req.url).pathname,
		status: response.status,
		message,
		token: trace.token ?? null,
		phone_id: trace.phoneId ?? null,
		user_agent: (c.req.header('user-agent') ?? '').slice(0, 200),
		content_type: (c.req.header('content-type') ?? '').slice(0, 100),
		...describeBody(raw, Boolean(trace.token) && !succeeded),
	})}`);
};

const handler: ApiHandler = async (c, next) => {
	// 先把请求体读成文本：叶子之后再读 JSON 走的是缓存，被拒的请求也照样记得下来。
	const raw = await c.req.text().catch(() => '');
	const trace: ReceiveTrace = {};
	const result = await authorize(c, next, trace);
	const response = result instanceof Response ? result : c.res;
	await recordReceive(c, response, raw, trace).catch((error: unknown) => console.error('sms receive log failed', error));
	return result;
};

const authorize = async (c: Parameters<ApiHandler>[0], next: Parameters<ApiHandler>[1], trace: ReceiveTrace) => {
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
	 * **令牌本身对不对，一律回同一句话。**
	 *
	 * 这一步的失败要模糊：说「这个令牌不存在」等于给了枚举的判据，拿一串猜的值就能测出
	 * 哪些是真的。
	 *
	 * 但**过了这一步之后就要说清楚**。文档 §8 要求「令牌被撤销、手机被禁用或已解绑时返回
	 * 确定性错误」，而合并成一句「设备不可用或凭证无效」让用户完全无从下手——他手里拿着
	 * 一个真令牌，却分不清是自己还没绑定手机、还是手机被停收了、还是令牌被撤销了，
	 * 三种情况的处理方式完全不同。
	 *
	 * 这不牺牲安全：能读到这些话的前提是**已经持有一个有效令牌**，而持有者本就知道这个
	 * 令牌的一切。偷到令牌的人确实能借此分辨「撤销了」还是「手机停用了」，但他已经拿着
	 * 令牌，这个区别对他没有用处——两种情况他都提交不了。
	 *
	 * 三句话都不回显令牌、完整手机号或数据库异常（§8）。
	 */
	const refuse = () => apiMessage(c, 401, '凭证无效：这个令牌不存在，或者与服务端记录的对不上');

	const digest = await sha256(token);
	const found = await firstSql<{ id: string; token_sha256: string; phone_id: string | null; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_shortcut_tokens',
		columns: { id: { column: 'id', cast: 'text' }, token_sha256: 'token_sha256', phone_id: { column: 'phone_id', cast: 'text' }, status: 'status' },
		where: [{ column: 'token_sha256', value: digest }],
		limit: 1,
	}));
	if (!found || !timingSafeEqual(String(found.token_sha256), digest)) {
		// 只为日志认一认是不是被删掉的旧令牌（清空令牌池之后，手机上装着的旧快捷指令就是
		// 这种）。回话不变：删掉的与从没存在过的，对外仍是同一句。
		const removed = await firstSql<{ id: string; phone_id: string | null; status: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_shortcut_tokens',
			columns: { id: { column: 'id', cast: 'text' }, phone_id: { column: 'phone_id', cast: 'text' }, status: 'status' },
			where: [{ column: 'token_sha256', value: digest }], deleted: 'all', limit: 1,
		})).catch(() => undefined);
		if (removed) Object.assign(trace, { token: { id: String(removed.id), status: String(removed.status), deleted: true }, phoneId: removed.phone_id ?? undefined });
		return refuse();
	}
	Object.assign(trace, { token: { id: String(found.id), status: String(found.status), deleted: false }, phoneId: found.phone_id ?? undefined });
	if (found.status === 'revoked') return apiMessage(c, 403, '这个令牌已被撤销，不能再提交短信。请重新领取一份 Shortcut 文件。');
	if (found.status === 'pending') return apiMessage(c, 403, '这个令牌还没有完成入库，暂时不能使用。这通常表示生成器那一步中断了，请联系管理员重新生成。');
	if (found.status !== 'bound' || !found.phone_id) return apiMessage(c, 403, '这个令牌还没有绑定手机。请先在「我的手机」页面用这份 Shortcut 完成绑定，再回来运行它。');

	const phone = await firstSql<{ id: string; owner_uid: string | null; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones',
		columns: { id: { column: 'id', cast: 'text' }, owner_uid: { column: 'owner_uid', cast: 'text' }, status: 'status' },
		where: [{ column: 'id', value: found.phone_id }],
		limit: 1,
	}));
	if (!phone) return apiMessage(c, 403, '这个令牌绑定的手机记录已经不存在了，请重新绑定一次。');
	if (phone.status === 'disabled') return apiMessage(c, 403, '这部手机已停收短信。请在「我的手机」页面把它改回「正常接收」。');
	if (phone.status === 'revoked') return apiMessage(c, 403, '这部手机已经解绑，不能再接收短信。要继续使用请重新绑定一次。');
	// 归属为空是数据异常而不是用户能处理的状态：短信写进去也没人看得到（NULL 归属对
	// 普通账号一律不可见）。说成「联系管理员」，别让用户对着一句状态描述反复重试。
	if (!phone.owner_uid) return apiMessage(c, 500, '这部手机没有归属账号，短信无法入账，请联系管理员处理。');

	// 主体交给叶子：谁的、哪一台。叶子不再碰凭证，也就没有「忘了验」这种可能。
	c.set('protocolSubject', { kind: 'token', ownerUid: String(phone.owner_uid), deviceId: String(phone.id) });
	return next();
};

export default handler;
