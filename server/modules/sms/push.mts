import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, runSql, sql } from '@server/database/sql.mjs';
import { loadSigningKey, signWithPlatformKey } from './platform-key.mjs';
import { resolvedTargetError } from './push-target.mjs';

/**
 * 把收到的短信推送到用户自己的服务端（绑定文档 §4.9）。
 *
 * 两步分开：收短信时只**登记**投递任务（一次插入，快），真正的 HTTP 由调度那一侧发出。
 * 合在一起的话，接收接口要等一个外部请求走完才回，而对面那台服务器慢一秒，手机上的
 * Shortcut 就多等一秒、超时重发，于是同一条短信被重复提交。
 */

/** 重试退避：1 分钟、5 分钟、30 分钟、2 小时、6 小时，之后放弃。 */
const RETRY_DELAYS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];

/**
 * 号码只给掩码（§4.9.2 要求不含原始令牌等敏感值，号码同理）：接收方需要知道「是哪一部
 * 手机收到的」，不需要完整号码——而完整号码一旦进了别人的日志就再也收不回来。
 */
const maskNumber = (value: string) => (value.length <= 4 ? value : `${value.slice(0, Math.max(3, value.length - 4))}****`);

type MessageRow = { id: string; phone_id: string; content: string; sender: string; recipients: string; received_at: string; owner_uid: string | null };

/**
 * 为一条短信登记投递任务。
 *
 * 匹配两个条件：**推送地址属于这条短信的主人**，并且**限定的手机对得上**（不填手机表示
 * 这个账号的全部手机）。
 *
 * 一条短信可以同时推给好几个地址——一部手机、一份 Shortcut、短信只进来一次，由服务端在
 * 这里分发给用户配的每一个项目。授权就是「用户为那个项目配了这条地址」这个动作本身，
 * 不必再有一张「谁可以收哪部手机」的关系表。
 *
 * `ignoreInsert` 配合 `(message_id, push_endpoint_id)` 的唯一约束——同一条短信对同一个
 * 目标只登记一次，重复调用是安全的。
 */
export const enqueuePushDeliveries = async (database: DatabaseAdapter, message: MessageRow) => {
	if (!message.owner_uid) return 0;
	const builder = sql({ database, subjectRoles: null });
	const endpoints = await allSql<{ id: string; phone_id: string | null }>(database, builder.select({
		table: 'sms_push_endpoints',
		columns: { id: { column: 'id', cast: 'text' }, phone_id: { column: 'phone_id', cast: 'text' } },
		where: [
			{ column: 'owner_uid', value: message.owner_uid },
			{ column: 'status', value: 'enabled' },
		],
	}));
	// 限定手机的那几条要按 phone_id 再筛一次。写在应用层而不是 SQL 里，是因为「不填表示
	// 全部手机」这条规则用 SQL 表达要 OR + IS NULL，读起来比这一行难懂得多。
	const matched = endpoints.filter((endpoint) => !endpoint.phone_id || String(endpoint.phone_id) === String(message.phone_id)).map((endpoint) => endpoint.id);
	for (const endpointId of matched) {
		await runSql(database, builder.ignoreInsert('sms_push_deliveries', ['message_id', 'push_endpoint_id'], {
			message_id: message.id,
			push_endpoint_id: endpointId,
			// 重试沿用同一个值，接收方按它去重（§4.9.3）。因此在**登记时**生成一次，
			// 而不是每次投递前生成——那样每重试一次就成了一条新消息。
			delivery_id: crypto.randomUUID(),
			status: 'pending',
			next_attempt_at: Date.now(),
			owner_uid: message.owner_uid,
		}));
	}
	return matched.length;
};

/** 一次投递的结果：成功、或者带一句人能看懂的失败原因。 */
const attemptDelivery = async (target: { url: string; deliveryId: string; payload: string; privateKey: string; kid: string }) => {
	// **每次投递前重做出站校验**：DNS 记录可以在保存之后被改指到内网（§4.9.1）。
	const blocked = await resolvedTargetError(target.url);
	if (blocked) return blocked;
	const timestamp = Math.floor(Date.now() / 1000);
	const signature = await signWithPlatformKey(target.privateKey, `${timestamp}.${target.payload}`);
	try {
		const response = await fetch(target.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-sms-timestamp': String(timestamp),
				'x-sms-delivery-id': target.deliveryId,
				// kid 也带上：轮换期间有两把公钥，接收方据此直接挑对，不必两把都试。
				'x-sms-key-id': target.kid,
				'x-sms-signature': `ed25519=${signature}`,
			},
			body: target.payload,
			signal: AbortSignal.timeout(10_000),
		});
		if (response.ok) return '';
		// 只留状态码，不回显对方的响应体：那里面可能是它自己的错误页，几十 KB 存进
		// last_error 既没用又占地方。
		return `目标返回 ${response.status}`;
	} catch (error) {
		return error instanceof Error ? `请求失败：${error.message}`.slice(0, 200) : '请求失败';
	}
};

/**
 * 跑一轮投递：取到期的任务，逐条发出去。
 *
 * 每轮有上限，不一次把积压全部发完——投递是对外的 HTTP，一次几百个并发出去，对面会把
 * 本站当成攻击源。漏发的下一轮继续，`next_attempt_at` 记着该什么时候再试。
 */
export const dispatchPushDeliveries = async (database: DatabaseAdapter, limit = 20) => {
	const builder = sql({ database, subjectRoles: null });
	const due = await allSql<{ id: string; message_id: string; push_endpoint_id: string; delivery_id: string; attempts: number }>(database, builder.select({
		table: 'sms_push_deliveries',
		columns: { id: { column: 'id', cast: 'text' }, message_id: { column: 'message_id', cast: 'text' }, push_endpoint_id: { column: 'push_endpoint_id', cast: 'text' }, delivery_id: 'delivery_id', attempts: 'attempts' },
		where: [{ column: 'status', value: 'pending' }, { column: 'next_attempt_at', operator: '<=', value: Date.now() }],
		orderBy: [{ column: 'next_attempt_at' }], limit,
	}));
	if (!due.length) return { sent: 0, failed: 0 };
	const signing = await loadSigningKey(database);
	let sent = 0;
	let failed = 0;
	for (const delivery of due) {
		const [message, endpoint] = await Promise.all([
			firstSql<Record<string, unknown>>(database, builder.select({
				table: 'sms_messages', alias: 'm',
				columns: { content: 'm.content', sender: 'm.sender', recipients: 'm.recipients', received_at: 'm.received_at', number: 'p.number' },
				joins: [{ type: 'LEFT', table: 'sms_phones', alias: 'p', left: 'p.id', right: 'm.phone_id' }],
				where: [{ column: 'm.id', value: delivery.message_id }], limit: 1,
			})),
			firstSql<{ url: string; status: string }>(database, builder.select({
				table: 'sms_push_endpoints', columns: { url: 'url', status: 'status' }, where: [{ column: 'id', value: delivery.push_endpoint_id }], limit: 1,
			})),
		]);
		/**
		 * 短信或目标已经没了（用户删掉了），这条任务就没有意义了——**标成成功而不是失败**：
		 * 失败会一直重试到次数用尽，每一轮都白跑一次查询，而结果永远不会变。
		 */
		if (!message || !endpoint || endpoint.status !== 'enabled') {
			await runSql(database, builder.update('sms_push_deliveries', { status: 'succeeded', last_error: '目标或短信已不存在，跳过' }, { id: delivery.id }));
			continue;
		}
		if (!signing) {
			await runSql(database, builder.update('sms_push_deliveries', { status: 'pending', last_error: '还没有生成推送签名密钥', next_attempt_at: Date.now() + RETRY_DELAYS[0] }, { id: delivery.id }));
			failed += 1;
			continue;
		}
		const payload = JSON.stringify({
			delivery_id: delivery.delivery_id,
			phone: maskNumber(String(message.number ?? '')),
			content: message.content,
			sender: message.sender || null,
			recipients: message.recipients || null,
			received_at: Number(message.received_at ?? 0),
		});
		const error = await attemptDelivery({ url: String(endpoint.url), deliveryId: delivery.delivery_id, payload, privateKey: String(signing.private_key), kid: String(signing.kid) });
		const attempts = Number(delivery.attempts ?? 0) + 1;
		if (!error) {
			await runSql(database, builder.update('sms_push_deliveries', { status: 'succeeded', attempts, last_error: '' }, { id: delivery.id }));
			await runSql(database, builder.update('sms_push_endpoints', { last_success_at: Date.now(), last_error: '' }, { id: delivery.push_endpoint_id }));
			sent += 1;
			continue;
		}
		// 次数用尽就落到 failed 终态：无限重试对一个已经搬走的地址毫无意义，而用户在
		// 「最近错误」里看得到发生了什么。
		const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
		const exhausted = attempts >= RETRY_DELAYS.length;
		await runSql(database, builder.update('sms_push_deliveries', {
			status: exhausted ? 'failed' : 'pending', attempts, last_error: error.slice(0, 200),
			next_attempt_at: exhausted ? 0 : Date.now() + delay,
		}, { id: delivery.id }));
		await runSql(database, builder.update('sms_push_endpoints', { last_error: error.slice(0, 200) }, { id: delivery.push_endpoint_id }));
		failed += 1;
	}
	return { sent, failed };
};
