import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { readChangeReason } from '@server/modules/base/operation.mjs';
import { STATUS_LABELS, describeAuditChanges, listAuditEntries, parseAuditChanges, publicAuditChanges, readAuditEntry, transitionAuditEntries, type AuditEntryRow } from '@server/modules/base/audit.mjs';

const actionLabels: Record<string, string> = { update: '修改', soft_delete: '删除', restore: '恢复' };
// 状态用带颜色的标签：绿色一眼看出这条变更此刻是生效的。
const statusOptions = [
	{ value: 'pending', text: STATUS_LABELS.pending, color: 'gold' },
	{ value: 'applied', text: STATUS_LABELS.applied, color: 'green' },
	{ value: 'rejected', text: STATUS_LABELS.rejected, color: 'red' },
	{ value: 'reverted', text: STATUS_LABELS.reverted, color: 'default' },
];
/** 每个动作对应一次状态迁移，并且只对处在起点状态的行显示。 */
const flipActions = [
	{ key: 'approve', label: '批准', to: 'applied' as const, from: 'pending', confirm: '确认批准这条修改吗？批准后立即生效。' },
	{ key: 'reject', label: '驳回', to: 'rejected' as const, from: 'pending', confirm: '确认驳回这条修改吗？数据不会被改动。' },
	{ key: 'revert', label: '撤回', to: 'reverted' as const, from: 'applied', confirm: '确认撤回这条变更吗？' },
	{ key: 'restore', label: '恢复', to: 'applied' as const, from: 'reverted', confirm: '确认恢复这条变更吗？' },
];

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
	{ dataIndex: 'status', title: '状态', options: statusOptions },
	{ dataIndex: 'reviewed_at', title: '审批时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'reviewed_duid', title: '审批人' },
	{ dataIndex: 'review_reason', title: '审批意见' },
	{ dataIndex: 'reverted_at', title: '撤回时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'reverted_duid', title: '撤回人' },
	{ dataIndex: 'revert_reason', title: '撤回理由' },
	{ dataIndex: 'restored_at', title: '恢复时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'restored_duid', title: '恢复人' },
	{ dataIndex: 'restore_reason', title: '恢复理由' },
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
	status: row.status,
	reviewed_at: row.reviewed_at ?? '',
	reviewed_duid: row.reviewed_duid ?? '',
	review_reason: row.review_reason ?? '',
	reverted_at: row.reverted_at ?? '',
	reverted_duid: row.reverted_duid ?? '',
	revert_reason: row.revert_reason ?? '',
	restored_at: row.restored_at ?? '',
	restored_duid: row.restored_duid ?? '',
	restore_reason: row.restore_reason ?? '',
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
				// 撤回与恢复是互斥的两个动作，一行上只显示其中适用的那个。
				toolbar: flipActions.map((action) => ({ key: action.key, label: `${action.label}选中记录`, confirm: action.confirm })),
				row: flipActions.map((action) => ({ key: action.key, label: action.label, confirm: action.confirm, visibleWhen: { field: 'status', values: [action.from] } })),
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
	const flip = c.req.method === 'POST' ? flipActions.find((action) => action.key === c.req.query('action')) : undefined;
	if (flip) {
		const ids = await readIds(c, params.id);
		if (!ids.length) return apiMessage(c, 400, `请选择要${flip.label}的记录`);
		const results = await transitionAuditEntries(database, ids, flip.to, readChangeReason(c));
		const failed = results.filter((result) => !result.ok);
		if (!failed.length) return apiMessage(c, 200, `已${flip.label} ${results.length} 条变更`);
		// 逐条独立判定：某一条被拒绝时其余照常执行，最后逐条返回结果（§7.4）。
		const detail = failed.map((result) => `#${result.id} ${result.message}`).join('；');
		return apiMessage(c, results.length === failed.length ? 409 : 200, `成功 ${results.length - failed.length} 条，失败 ${failed.length} 条：${detail}`);
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
