import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { describeAuditChanges, listAuditEntries, parseAuditChanges, publicAuditChanges, readAuditEntry, revertAuditEntries, type AuditEntryRow } from '@server/modules/base/audit.mjs';

const actionLabels: Record<string, string> = { update: '修改', soft_delete: '删除', restore: '恢复' };
const statusLabels: Record<string, string> = { applied: '已生效', reverted: '已撤回' };

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'table_name', title: '数据表' },
	{ dataIndex: 'row_id', title: '记录' },
	{ dataIndex: 'action', title: '动作' },
	{ dataIndex: 'summary', title: '变更内容' },
	{ dataIndex: 'reason', title: '操作原因' },
	{ dataIndex: 'created_duid', title: '操作者' },
	{ dataIndex: 'owner_uid', title: '作用账号' },
	{ dataIndex: 'status', title: '状态' },
	{ dataIndex: 'reverted_at', title: '撤回时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'reverted_duid', title: '撤回人' },
	{ dataIndex: 'revert_reason', title: '撤回理由' },
];

const publicEntry = (row: AuditEntryRow) => ({
	id: row.id,
	created_at: row.created_at,
	table_name: row.table_name,
	row_id: row.row_id,
	action: actionLabels[row.action] ?? row.action,
	summary: describeAuditChanges(parseAuditChanges(row.changes)),
	reason: row.reason ?? '',
	created_duid: row.created_duid ?? '',
	owner_uid: row.owner_uid ?? '',
	status: statusLabels[row.status] ?? row.status,
	reverted_at: row.reverted_at ?? '',
	reverted_duid: row.reverted_duid ?? '',
	revert_reason: row.revert_reason ?? '',
});

const readIds = async (c: Parameters<ApiHandler>[0], routeId?: string) => {
	if (routeId) return [routeId];
	const body = await c.req.json<unknown>().catch(() => []);
	return Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : [];
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	if (c.req.method === 'GET' && !params.id) {
		const rows = await listAuditEntries(database);
		return apiResponse(c, 200, { table: {
			// 审计记录不可修改、不可删除，接口层因此没有新增、编辑与删除入口（§7.3）。
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 撤回不新开记录，而是把这一条翻到另一面；已撤回的再点一次就恢复。
				toolbar: [{ key: 'revert', label: '撤回 / 恢复选中记录', confirm: '确认翻转选中的变更吗？撤回按时间从新到旧、恢复从旧到新逐条执行。' }],
				row: [{ key: 'revert', label: '撤回 / 恢复', confirm: '确认翻转这条变更吗？' }],
			} },
			columns,
			dataSource: rows.map(publicEntry),
			totalRecords: rows.length,
		} });
	}
	if (params.id && c.req.method === 'GET') {
		const row = await readAuditEntry(database, params.id);
		if (!row) return apiMessage(c, 404, '审计记录不存在');
		return apiResponse(c, 200, { ...publicEntry(row), changes: publicAuditChanges(parseAuditChanges(row.changes)) });
	}
	if (c.req.method === 'POST' && c.req.query('action') === 'revert') {
		const ids = await readIds(c, params.id);
		if (!ids.length) return apiMessage(c, 400, '请选择要撤回的记录');
		const body = await c.req.json<unknown>().catch(() => undefined);
		const reason = body && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>)._reason === 'string' ? String((body as Record<string, unknown>)._reason).trim().slice(0, 500) : '';
		const results = await revertAuditEntries(database, ids, reason);
		const failed = results.filter((result) => !result.ok);
		if (!failed.length) return apiMessage(c, 200, `已处理 ${results.length} 条变更`);
		// 逐条独立判定：某一条被拒绝时其余照常执行，最后逐条返回结果（§7.4）。
		const detail = failed.map((result) => `#${result.id} ${result.message}`).join('；');
		return apiMessage(c, results.length === failed.length ? 409 : 200, `成功 ${results.length - failed.length} 条，失败 ${failed.length} 条：${detail}`);
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
