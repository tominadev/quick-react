import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData } from '@server/modules/base/api-response.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { bindPhone, normalizePhoneNumber } from '@server/modules/sms/binding.mjs';
import { consumeTicketNonce, verifyBindingTicket } from '@server/modules/sms/ticket.mjs';

/**
 * 接入方代表用户绑定手机（绑定文档 §6.2 的票据路径）。
 *
 * ```http
 * POST /api/client/phone-bind
 * { "ticket": "<base64url(payload)>.<base64url(signature)>" }
 * ```
 *
 * 步骤与文档一字对应：验票据 → 校验目标账号与号码 → **消费 nonce** → 建绑定 → 领令牌 →
 * 回下载地址。
 */
const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'POST') return next();
	const database = c.get('database');
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const verified = await verifyBindingTicket(database, String(body.ticket ?? ''));
	if (!verified.ok) return apiMessage(c, verified.failure.status, verified.failure.message);
	const { payload, clientRowId } = verified;

	const number = normalizePhoneNumber(payload.phone);
	if (!number) return apiMessage(c, 400, '手机号码格式不正确');

	/**
	 * 目标账号必须真的存在于本库。
	 *
	 * 不存在与「不允许该接入方操作」回同一句话（§7.2）：能签票据的人不该再多得到一个
	 * 「这个账号在不在」的探测器——那是一份可以枚举的用户名单。
	 */
	const target = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'base_users', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'id', value: payload.base_user_id }, { column: 'status', value: 'enabled' }], limit: 1,
	}));
	if (!target) return apiMessage(c, 403, '目标身份无权绑定手机');

	/**
	 * **接入方只能绑到自己名下的账号所注册的项目上**——换句话说，这个项目得是那个用户的。
	 * 不查这一层的话，甲的接入方可以拿乙的 base_user_id 签一张票据，把手机绑进乙的账号，
	 * 而短信推给甲配的地址。
	 */
	const owned = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'id', value: clientRowId }, { column: 'owner_uid', value: payload.base_user_id }], limit: 1,
	}));
	if (!owned) return apiMessage(c, 403, '目标身份无权绑定手机');

	/**
	 * **消费 nonce 必须排在绑定之前**（§6.2 第 5 步）。
	 *
	 * nonce 一旦消费成功票据即作废；后续失败时接入方要重新签一张，而不是能用同一张重试。
	 * 反过来（先绑定后消费）在无事务环境下会留下「绑定成功但 nonce 未消费」——同一张票据
	 * 还能再绑一次，比「消费了但没绑成」糟得多。
	 */
	if (!await consumeTicketNonce(database, clientRowId, payload.nonce, Number(payload.exp ?? 0))) {
		return apiMessage(c, 409, '绑定票据已使用');
	}

	/**
	 * **写入时显式绑定归属**：这条路径没有本站会话，公共层的归属上下文是空的，不绑的话
	 * `owner_uid` 会被填成 NULL——而 NULL 归属的行对普通账号一律不可见，用户自己看不到
	 * 自己刚绑的手机。
	 */
	const ownedDatabase = withDatabaseActors(database, { baseUserId: payload.base_user_id });
	const outcome = await bindPhone({
		database: ownedDatabase,
		globalDatabase: c.get('globalDatabase'),
		siteKey: c.get('site').siteKey,
		ownerUid: payload.base_user_id,
		clientId: clientRowId,
		number,
		title: String(body.title ?? '').trim().slice(0, 64),
		runWrite: (statement) => runSql(ownedDatabase, statement),
	});
	if (!outcome.ok) return apiMessage(c, outcome.status, outcome.message);
	return apiMessageData(c, 200, outcome.alreadyBound ? '这个号码已经绑定过了' : '绑定成功', {
		number: outcome.number,
		// 让接入方把它交给手机的主人：在**那部手机上**打开才有意义。
		download_url: outcome.downloadUrl ?? null,
		already_bound: outcome.alreadyBound,
		expires_in: 900,
	});
};

export default handler;
