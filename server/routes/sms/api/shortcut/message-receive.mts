import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { runSql, sql } from '@server/database/sql.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';

/**
 * Shortcut 提交短信。
 *
 * ```http
 * POST /api/shortcut/message-receive
 * Authorization: Bearer <原始令牌>
 * Content-Type: application/json
 *
 * { "message_id": "<手机侧的稳定标识>", "content": "短信正文",
 *   "recipients": ["+8613800000000"], "sender": "+8613900000000" }
 * ```
 *
 * **凭证在 `/api/shortcut.mts` 验过一次且只验一次**，这里拿到的是一个确定的主体，只管把短信
 * 写下去。
 */

const textField = (value: unknown, limit: number) => (typeof value === 'string' ? value : '').slice(0, limit);

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'POST') return next();
	const subject = c.get('protocolSubject');
	// **这不是第二道验证**，是类型收窄：`protocolSubject` 在协议之外的接口上不存在，因此
	// 声明成可选。凭证在 `/api/shortcut.mts` 验过一次且只验一次；走到这里主体必然在。
	if (!subject?.deviceId) return apiMessage(c, 401, '设备不可用或凭证无效');

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const content = textField(body.content, 4000);
	if (!content) return apiMessage(c, 400, '短信正文不能为空');
	/**
	 * **去重靠手机侧给的稳定标识，不靠服务端时间。**
	 *
	 * 一开始把 `received_at` 算进哈希，实测重复提交同一条会进两行：服务端时间每次都不同，
	 * 重试自然算出两个哈希。而重试正是这条接口最常见的并发来源——Shortcut 网络不稳就会重发。
	 *
	 * 也不能只按正文与发送人算：`(phone_id, payload_hash)` 那条唯一索引不带 `deleted_at`，
	 * 软删掉的短信仍占着它的哈希，用户删掉一条之后同样内容的下一条会被当成重复丢弃。
	 *
	 * 所以标识必须来自手机侧、且重试时不变——与推送那边的 `delivery_id` 是同一个模式
	 * （§4.9.3「稳定标识，重试沿用同一值」）。没给就退回按内容算：老版本 Shortcut 仍能用，
	 * 只是失去「删掉之后再收到同样内容」这一种区分。
	 */
	const messageId = textField(body.message_id, 128);
	const sender = textField(body.sender, 64);
	const recipients = Array.isArray(body.recipients)
		? body.recipients.map((item) => textField(item, 64)).filter(Boolean).join(',').slice(0, 512)
		: textField(body.recipients, 512);
	const payloadHash = await sha256([subject.deviceId, messageId, content, sender, recipients].join('\n'));

	/**
	 * **写入前显式绑定归属。**
	 *
	 * 这一刻没有登录会话，公共层的归属上下文是空的；不绑的话 `owner_uid` 会被填成 NULL，
	 * 而 NULL 归属的行对普通账号一律不可见——短信的主人自己也看不到自己的短信。
	 */
	const database = c.get('database');
	const owned = withDatabaseActors(database, { baseUserId: subject.ownerUid });
	/**
	 * 去重靠唯一索引加 `ignoreInsert`，**不先查后插**：无事务环境下先查后插存在竞态，而
	 * 重试恰好是并发的典型来源。撞上就静默跳过，回执照样是成功——对调用方来说「这条已经
	 * 收到了」和「刚收下」没有区别，让它重试到成功为止才是对的。
	 */
	const receivedAt = Date.now();
	await runSql(owned, sql({ database: owned }).ignoreInsert('sms_messages', ['phone_id', 'payload_hash'], {
		phone_id: subject.deviceId,
		content,
		recipients,
		sender,
		received_at: receivedAt,
		payload_hash: payloadHash,
	}));
	await runSql(database, sql({ database, subjectRoles: null }).update('sms_shortcut_tokens', { last_used_at: receivedAt }, { phone_id: subject.deviceId }));
	return apiMessage(c, 200, '已接收');
};

export default handler;
