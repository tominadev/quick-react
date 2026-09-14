import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { enqueuePushDeliveries } from '@server/modules/sms/push.mjs';
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

/**
 * 自检：告诉运行它的人，**这份快捷指令绑的是哪个号码**。
 *
 * 读这句话的是**手机的主人**，不是平台用户——「推送地址」「所属项目」对他都是黑话，所以
 * 只说号码、他给这部手机起的名字、以及还差哪一步（自动化）。推送有没有配是平台用户关心的事，
 * 放在后台「我的手机」里提示。
 *
 * **号码完整回显，不打码。** 能走到这里的人已经持有一个有效令牌，本来就能收到这部手机的
 * 每一条短信，号码比短信轻得多（理由同 shortcut.mts 那段）。推送里打的是后四位，而后四位
 * 恰恰是分辨「这是哪一部」的那几位，打了码这句话就失去意义。
 *
 * 回执写成一行：快捷指令把响应当字典显示，字符串里的换行会原样露出 `\n`。
 */
const selfCheck = async (c: Parameters<ApiHandler>[0], phoneId: string) => {
	const database = c.get('database');
	const builder = sql({ database, subjectRoles: null });
	const phone = await firstSql<{ number: string; title: string }>(database, builder.select({
		table: 'sms_phones', columns: { number: 'number', title: 'title' }, where: [{ column: 'id', value: phoneId }], limit: 1,
	}));
	// 只刷新自检时间，**不碰令牌的 last_used_at**：那一格是「最近收到短信」，两件事分开记，
	// 手机死了「最近自检」就不动，前后对照一眼看得出。
	await runSql(database, builder.update('sms_phones', { last_check_at: Date.now() }, { id: phoneId }));
	const named = phone?.title ? `${phone.number}（${phone.title}）` : String(phone?.number ?? '');
	/**
	 * **不能说「以后会自动转发」**：iOS 的快捷指令不会自己在收到短信时运行，要在「自动化」
	 * 里建一条「收到信息时运行」。而这里判断不出建没建——手动运行时，配没配自动化看起来
	 * 一模一样。所以每次都提醒，宁可多说一句，也不能让人以为设好了、实际一条都不转。
	 */
	return apiMessage(c, 200, `测试成功：这个快捷指令绑定的手机号码是 ${named}。要在收到短信时自动转发，还需要在「快捷指令」App 的「自动化」里新建一条：收到信息时，立即运行这个快捷指令。`);
};

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'POST') return next();
	const subject = c.get('protocolSubject');
	// **这不是第二道验证**，是类型收窄：`protocolSubject` 在协议之外的接口上不存在，因此
	// 声明成可选。凭证在 `/api/shortcut.mts` 验过一次且只验一次；走到这里主体必然在。
	// 走到这里 shortcut.mts 必定已经解析出主体；没有就是那一层被改坏了，不是调用方的问题。
	if (!subject?.deviceId) return apiMessage(c, 500, '服务端没有解析出设备主体，这是一个内部错误，请联系管理员');

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const content = textField(body.content, 4000);
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

	if (!content) {
		/**
		 * **三个字段都空，才是手机的主人在手动运行快捷指令**——没有短信触发，取不到任何东西。
		 *
		 * 不能只看正文空：哪天 iOS 改版、快捷指令取不到正文了，每一条真短信都会变成空正文，
		 * 若一律当自检收下，就全都不入账、不推送，而后台看着「最近自检：刚刚」一切正常——
		 * 最难查的那一类故障。真短信总带着发送人，所以「正文空但有发送人」照旧报错，
		 * 而且要说清是哪一种错。
		 */
		if (messageId || sender || recipients) {
			return apiMessage(c, 400, '收到了一条短信，但没有取到正文。这通常是系统更新后快捷指令读不到短信内容了，请联系服务方重新获取一份快捷指令。');
		}
		return selfCheck(c, subject.deviceId);
	}
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

	/**
	 * 登记推送任务，**不在这里发出去**。
	 *
	 * 真正的 HTTP 由调度那一侧发（见 push.mts）：合在一起的话，这个接口要等一个外部请求
	 * 走完才回，而对面那台服务器慢一秒，手机上的 Shortcut 就多等一秒、超时重发——同一条
	 * 短信于是被重复提交。登记只是一次插入。
	 *
	 * 失败不影响回执：短信已经收下了，推送没登记上是另一件事，让它在日志里出现就好，
	 * 回一句失败会让 Shortcut 一直重发同一条。
	 */
	const stored = await firstSql<{ id: string; phone_id: string; content: string; sender: string; recipients: string; received_at: string; owner_uid: string | null }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_messages',
		columns: { id: { column: 'id', cast: 'text' }, phone_id: { column: 'phone_id', cast: 'text' }, content: 'content', sender: 'sender', recipients: 'recipients', received_at: 'received_at', owner_uid: { column: 'owner_uid', cast: 'text' } },
		where: [{ column: 'phone_id', value: subject.deviceId }, { column: 'payload_hash', value: payloadHash }], limit: 1,
	}));
	if (stored) await enqueuePushDeliveries(database, stored).catch((error: unknown) => console.error('push enqueue failed', error));
	return apiMessage(c, 200, '已接收');
};

export default handler;
