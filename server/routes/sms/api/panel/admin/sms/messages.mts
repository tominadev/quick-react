import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 全站短信。管理员排查用——用户报「没收到验证码」时，这里是唯一能看出短信到底进没进来的地方。
 *
 * **这一页看得到验证码。** 短信正文原样存着，管理员因此能读到任何一部绑定手机收到的验证码
 * 与通知。这是排查能力的代价，不是疏忽：内容不留就没法回答「到底收没收到」，而那正是这一页
 * 存在的理由。能看到的范围仍由公共层的归属判定收敛到本租户或本分站，页面本身再限管理员角色，
 * 两层各自独立生效。
 *
 * 只读加删除。短信由 Shortcut 用 Bearer 令牌写入（`/api/shortcut/message-receive`），
 * 在这里补一条或改一个字，这张表也就不能拿来对账了。
 */

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '入库时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'phone_number', title: '接收手机', emptyText: '手机已删除' },
	// 接入方通过票据绑定这部手机时传的引用串，原样存在 sms_phones.client_ref 上，推送时
	// 也是原样带给接入方的那个值。管理员排查「用户说没收到，但接入方说也没推送」这类问题时，
	// 这一列能直接对上接入方那边日志里记的是哪个引用。
	{ dataIndex: 'client_ref', title: '接入方引用', emptyText: '未设置' },
	{ dataIndex: 'owner_name', title: '归属账号', emptyText: '无归属' },
	// 正文多行显示：通知类短信经常两三行，截断了就得逐条点开看。
	{ dataIndex: 'content', title: '内容', tableDisplay: 'multiline' as const },
	{ dataIndex: 'recipients', title: '收件人', emptyText: '未提供' },
	{ dataIndex: 'sender', title: '发送人', emptyText: '未知' },
	{ dataIndex: 'received_at', title: '接收时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' }];

export const tableCrud: TableCrudDefinition = { table: 'sms_messages', rowKey: 'id' };

const listColumns = {
	id: { column: 'm.id', cast: 'text' as const }, created_at: 'm.created_at',
	phone_number: 'p.number', client_ref: 'p.client_ref', owner_name: 'u.name',
	content: 'm.content', recipients: 'm.recipients', sender: 'm.sender', received_at: 'm.received_at',
} as const;
const listJoins = [
	{ type: 'LEFT' as const, table: 'sms_phones', alias: 'p', left: 'p.id', right: 'm.phone_id' },
	// 归属账号在 base 库的用户表上；业务站点只用自己的表与 base 的表。
	{ type: 'LEFT' as const, table: 'base_users', alias: 'u', left: 'u.id', right: 'm.owner_uid' },
];

const queryFields = [
	{ dataIndex: 'phone_number', label: '手机号', component: 'textbox' as const, placeholder: '按号码筛' },
	{ dataIndex: 'sender', label: '发送人', component: 'textbox' as const, placeholder: '如 10086' },
	{ dataIndex: 'content', label: '内容', component: 'textbox' as const, placeholder: '按正文关键词筛' },
];

const publicMessage = (row: Record<string, unknown>) => ({
	id: row.id,
	created_at: row.created_at,
	phone_number: row.phone_number ?? null,
	client_ref: row.client_ref || null,
	owner_name: row.owner_name ?? null,
	content: row.content,
	recipients: row.recipients || null,
	sender: row.sender || null,
	received_at: row.received_at,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const builder = sql({ database });
	// 三个筛选都不预设默认值：参数缺失就是不筛这一项（与审计页同一套说法）。
	const filters = [
		...builder.search('p.number', c.req.query('phone_number'), 'like'),
		...builder.search('m.sender', c.req.query('sender'), 'like'),
		...builder.search('m.content', c.req.query('content'), 'like'),
	];

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, builder.select({
			table: 'sms_messages', alias: 'm', columns: listColumns, joins: listJoins, where: filters,
			sort: tableSort(c), orderBy: [{ column: 'm.received_at', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', queryFields, actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 没有新增与编辑：短信只由接收接口写入，在这里补一条或改一个字，
				// 这张表也就不能拿来对账了。
				toolbar: [{ key: 'delete', label: '删除' }],
				row: [{ key: 'delete', label: '删除' }],
			} },
			columns, dataSource: rows.map(publicMessage), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, builder.select({
			table: 'sms_messages', alias: 'm', columns: listColumns, joins: listJoins, where: [{ column: 'm.id', value: params.id }],
		}));
		return row ? apiResponse(c, 200, publicMessage(row)) : apiMessage(c, 404, '短信不存在');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的短信');
		// 整批一次提交：一条一条走的话第一条就抛「已提交审批」，其余静默丢失。
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_messages', { id })));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
