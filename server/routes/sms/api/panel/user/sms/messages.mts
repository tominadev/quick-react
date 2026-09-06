import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperationSql } from '@server/modules/base/operation.mjs';
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

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'phone_number', title: '接收手机', emptyText: '手机已删除' },
	// 正文多行显示：验证码短信不长，但通知类的经常两三行，截断了就得逐条点开看。
	{ dataIndex: 'content', title: '内容', tableDisplay: 'multiline' as const },
	{ dataIndex: 'recipients', title: '收件人', emptyText: '未提供' },
	{ dataIndex: 'sender', title: '发送人', emptyText: '未知' },
	{ dataIndex: 'received_at', title: '接收时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' }];

export const tableCrud: TableCrudDefinition = { table: 'sms_messages', rowKey: 'id' };

const listColumns = {
	id: { column: 'm.id', cast: 'text' as const }, phone_number: 'p.number',
	sender: 'm.sender', content: 'm.content', recipients: 'm.recipients', received_at: 'm.received_at',
} as const;
const listJoins = [{ type: 'LEFT' as const, table: 'sms_phones', alias: 'p', left: 'p.id', right: 'm.phone_id' }];

const publicMessage = (row: Record<string, unknown>) => ({
	id: row.id,
	phone_number: row.phone_number ?? null,
	sender: row.sender || null,
	content: row.content,
	recipients: row.recipients || null,
	received_at: row.received_at,
});

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
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'delete', label: '删除' }],
				row: [{ key: 'delete', label: '删除' }],
			} },
			columns, dataSource: rows.map(publicMessage), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_messages', alias: 'm', columns: listColumns, joins: listJoins,
			where: [{ column: 'm.id', value: params.id }, mine()],
		}));
		return row ? apiResponse(c, 200, publicMessage(row)) : apiMessage(c, 404, '短信不存在');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的短信');
		for (const id of ids) await runOperationSql(c, database, sql({ database }).softDelete('sms_messages', [{ column: 'id', value: id }, mine('owner_uid')]));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
