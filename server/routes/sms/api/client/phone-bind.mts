import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData } from '@server/modules/base/api-response.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { bindPhone, normalizePhoneNumber } from '@server/modules/sms/binding.mjs';
import { consumeTicketNonce, verifyBindingTicket } from '@server/modules/sms/ticket.mjs';

/**
 * 接入方代表自己的账号绑定手机（绑定文档 §6.2 的票据路径）。
 *
 * ```http
 * POST /api/client/phone-bind
 * { "ticket": "<base64url(payload)>.<base64url(signature)>" }
 * ```
 *
 * 步骤与文档一字对应：验票据（顺带定出身份）→ 校验号码 → **消费 nonce** → 建绑定 →
 * 领令牌 → 回下载地址。
 */
const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'POST') return next();
	const database = c.get('database');
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const verified = await verifyBindingTicket(database, String(body.ticket ?? ''));
	if (!verified.ok) return apiMessage(c, verified.failure.status, verified.failure.message);
	const { clientRowId, ownerUid } = verified;

	const number = normalizePhoneNumber(verified.phone);
	if (!number) return apiMessage(c, 400, '手机号码格式不正确：请填国际格式，如 +8613800138000');

	/**
	 * 归属账号取自**这把公钥所属的接入方**，不由调用方指定——所以「绑到谁名下」这件事
	 * 不可能填错，也不可能越权。这里只剩一个检查：那个账号还在不在、还能不能用。
	 */
	const owner = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'base_users', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'id', value: ownerUid }, { column: 'status', value: 'enabled' }], limit: 1,
	}));
	if (!owner) return apiMessage(c, 403, '这把公钥的归属账号已停用或不存在');

	/**
	 * **消费 nonce 必须排在绑定之前**（§6.2 第 5 步）。
	 *
	 * nonce 一旦消费成功票据即作废；后续失败时接入方要重新签一张，而不是能用同一张重试。
	 * 反过来（先绑定后消费）在无事务环境下会留下「绑定成功但 nonce 未消费」——同一张票据
	 * 还能再绑一次，比「消费了但没绑成」糟得多。
	 */
	if (!await consumeTicketNonce(database, clientRowId, verified.nonce, verified.expiresAt)) {
		return apiMessage(c, 409, '绑定票据已使用：重试要换一张新票据（新的 nonce 与 iat/exp）');
	}

	/**
	 * **写入时显式绑定归属**：这条路径没有本站会话，公共层的归属上下文是空的，不绑的话
	 * `owner_uid` 会被填成 NULL——而 NULL 归属的行对普通账号一律不可见，用户自己看不到
	 * 自己刚绑的手机。
	 */
	const ownedDatabase = withDatabaseActors(database, { baseUserId: ownerUid });
	const outcome = await bindPhone({
		database: ownedDatabase,
		globalDatabase: c.get('globalDatabase'),
		siteKey: c.get('site').siteKey,
		ownerUid,
		clientId: clientRowId,
		number,
		title: String(body.title ?? '').trim().slice(0, 64),
		runWrite: (statement) => runSql(ownedDatabase, statement),
	});
	if (!outcome.ok) return apiMessage(c, outcome.status, outcome.message);
	const message = outcome.reissued ? '这个号码原来的快捷指令已经失效，已换发一份新的'
		: outcome.alreadyBound ? '这个号码已经绑定过了' : '绑定成功';
	return apiMessageData(c, 200, message, {
		number: outcome.number,
		// 让接入方把它交给手机的主人：在**那部手机上**打开才有意义。
		download_url: outcome.downloadUrl ?? null,
		already_bound: outcome.alreadyBound,
		// 为真时手机上装着的旧快捷指令已经不能用了，要让手机的主人换装这一份（并把自动化指向它）。
		reissued: outcome.reissued,
		expires_in: 900,
	});
};

export default handler;
