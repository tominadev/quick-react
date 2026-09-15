import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 我的短信：已绑定手机收到的内容。
 *
 * **只读加删除。** 短信由 Shortcut 用 Bearer 令牌写入（`/api/shortcut/message-receive`），
 * 这一页凭空写一条只是伪造收件记录；能改的话，这张表也就不能拿来对账了。
 *
 * 删除是软删，进回收站。另有一条与它无关的清理：超过保留期的记录**物理删除**
 * （站点配置 `sms.message_retention_days`，默认 90 天）——软删只是标记，表体积照涨，
 * 而这是本站唯一会持续膨胀的表。
 */

const PUSH_STATUS_OPTIONS = [
	{ value: 'succeeded', text: '已推送', color: 'green' },
	{ value: 'pending', text: '重试中', color: 'gold' },
	{ value: 'failed', text: '推送失败', color: 'red' },
	{ value: 'unmatched', text: '未匹配推送地址', color: 'default' },
];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'phone_number', title: '接收手机', emptyText: '手机已删除' },
	// 正文多行显示：验证码短信不长，但通知类的经常两三行，截断了就得逐条点开看。
	{ dataIndex: 'content', title: '内容', tableDisplay: 'multiline' as const },
	{ dataIndex: 'recipients', title: '收件人', emptyText: '未提供' },
	{ dataIndex: 'sender', title: '发送人', emptyText: '未知' },
	{ dataIndex: 'received_at', title: '接收时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	// 绑定这部手机时接入方传的引用串（原样存在 sms_phones.client_ref 上），推送给接入方
	// 时也是原样带回去的那个值——这里显示出来，方便用户自己核对"这部手机对应的是哪个客户"。
	{ dataIndex: 'client_ref', title: '接入方引用', emptyText: '未设置' },
	/**
	 * **短信记录与投递记录原来是两张互不相通的表**：这一页只显示短信内容，「推送地址」页
	 * 只有端点级别的「最近成功/最近错误」——看不出**这一条具体的短信**推没推、成没成功，
	 * 用户只能去问管理员或者猜。这一列把 `sms_push_deliveries` 卷进来，按每条短信显示。
	 *
	 * 一条短信可能匹配好几个推送地址（虽然目前多数账号只配一个），这里显示**最差的那个
	 * 状态**：只要有一个地址还没成功，就不该让用户以为"已经推送"。
	 */
	{ dataIndex: 'push_status', title: '推送状态', options: PUSH_STATUS_OPTIONS, form: { create: false as const, edit: false as const } },
	{ dataIndex: 'push_error', title: '推送错误', emptyText: '无', ellipsis: true, form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_messages', rowKey: 'id' };

const listColumns = {
	id: { column: 'm.id', cast: 'text' as const }, phone_number: 'p.number', client_ref: 'p.client_ref',
	sender: 'm.sender', content: 'm.content', recipients: 'm.recipients', received_at: 'm.received_at',
} as const;
const listJoins = [{ type: 'LEFT' as const, table: 'sms_phones', alias: 'p', left: 'p.id', right: 'm.phone_id' }];

const publicMessage = (row: Record<string, unknown>) => ({
	id: row.id,
	phone_number: row.phone_number ?? null,
	client_ref: row.client_ref || null,
	sender: row.sender || null,
	content: row.content,
	recipients: row.recipients || null,
	received_at: row.received_at,
});

/**
 * 按「最差状态优先」合并一条短信名下的多条投递记录。`failed`（重试次数用尽）最要紧，
 * 其次是还在排队/重试中的 `pending`/`sending`，全部 `succeeded` 才算真的推送成功。
 * 没有任何投递记录（例如短信到达时还没配推送地址）算 `unmatched`。
 */
const PUSH_RANK: Record<string, number> = { failed: 3, sending: 2, pending: 2, succeeded: 1 };
const worstDelivery = (deliveries: Array<{ status: string; last_error: string }>) => {
	if (!deliveries.length) return { push_status: 'unmatched', push_error: null };
	const worst = deliveries.reduce((a, b) => (PUSH_RANK[b.status] > PUSH_RANK[a.status] ? b : a));
	return { push_status: worst.status === 'sending' ? 'pending' : worst.status, push_error: worst.last_error || null };
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	// 理由同 phones.mts：这一页的语义就是「我的短信」，不随归属判定将来的放宽而放宽。
	const mine = (column = 'm.owner_uid') => ownerScope(column, currentUser.id);

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_messages', alias: 'm', columns: listColumns, joins: listJoins, where: [mine()],
			sort: tableSort(c), orderBy: [{ column: 'm.received_at', direction: 'DESC' }],
		}));
		// 一次取回这个人名下全部投递记录，按 message_id 分组配对——同「我的手机」那一列
		// 「转发到服务器」同样的做法：一个人的投递记录量级不大，不必逐行查。
		const deliveries = await allSql<{ message_id: string; status: string; last_error: string }>(database, sql({ database }).select({
			table: 'sms_push_deliveries', columns: { message_id: { column: 'message_id', cast: 'text' }, status: 'status', last_error: 'last_error' },
			where: [ownerScope('owner_uid', currentUser.id)],
		}));
		const deliveriesByMessage = new Map<string, Array<{ status: string; last_error: string }>>();
		for (const delivery of deliveries) {
			const list = deliveriesByMessage.get(delivery.message_id) ?? [];
			list.push(delivery);
			deliveriesByMessage.set(delivery.message_id, list);
		}
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'delete', label: '删除' }],
				row: [{ key: 'delete', label: '删除' }],
			} },
			columns, dataSource: rows.map((row) => ({ ...publicMessage(row), ...worstDelivery(deliveriesByMessage.get(String(row.id)) ?? []) })), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_messages', alias: 'm', columns: listColumns, joins: listJoins,
			where: [{ column: 'm.id', value: params.id }, mine()],
		}));
		if (!row) return apiMessage(c, 404, '短信不存在');
		const deliveries = await allSql<{ status: string; last_error: string }>(database, sql({ database }).select({
			table: 'sms_push_deliveries', columns: { status: 'status', last_error: 'last_error' },
			where: [{ column: 'message_id', value: params.id }, ownerScope('owner_uid', currentUser.id)],
		}));
		return apiResponse(c, 200, { ...publicMessage(row), ...worstDelivery(deliveries) });
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的短信');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_messages', [{ column: 'id', value: id }, mine('owner_uid')])));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
