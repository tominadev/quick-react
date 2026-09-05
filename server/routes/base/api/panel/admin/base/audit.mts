import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { readChangeReason } from '@server/modules/base/operation.mjs';
import type { SqlCondition } from '@server/database/sql.mjs';
import { STATUS_LABELS, countAuditEntries, describeAuditChanges, listAuditEntries, parseAuditChanges, publicAuditChanges, readAuditEntry, transitionAuditEntries, type AuditEntryRow } from '@server/modules/base/audit.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

const actionLabels: Record<string, string> = { update: '修改', soft_delete: '删除', restore: '恢复' };
// 状态用带颜色的标签：绿色一眼看出这条变更此刻是生效的。
const statusOptions = [
	{ value: 'pending', text: STATUS_LABELS.pending, color: 'gold' },
	{ value: 'applied', text: STATUS_LABELS.applied, color: 'green' },
	{ value: 'rejected', text: STATUS_LABELS.rejected, color: 'red' },
	{ value: 'reverted', text: STATUS_LABELS.reverted, color: 'default' },
];
/**
 * 查询条件。**状态默认「待审批」**：进这一页最常做的事是处理积压的申请，
 * 而不是翻历史；要看全部把它清空即可。
 */
const DEFAULT_STATUS = 'pending';
// 「全部」用显式哨兵值而不是空串：空串在 antd 的 Select 里等于「没有选中」，
// 选完会显示成空白。顺带让 URL 自解释——status=all 比 status= 一眼看得懂。
const ALL_STATUS = 'all';
const queryFields = [
	{ dataIndex: 'status', label: '状态', component: 'select' as const, defaultValue: DEFAULT_STATUS, options: [{ value: ALL_STATUS, text: '全部' }, ...statusOptions] },
	{ dataIndex: 'table_name', label: '数据表', component: 'textbox' as const, placeholder: '例如 base_users' },
	{ dataIndex: 'row_id', label: '记录 ID', component: 'textbox' as const },
	{ dataIndex: 'reason', label: '操作原因', component: 'textbox' as const, placeholder: '模糊匹配，% 与 _ 是通配符' },
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
	// 一列一行；multiline 模式带 pre-wrap 与三行折叠，改得多也不会撑爆表格。
	{ dataIndex: 'summary', title: '变更内容', tableDisplay: 'multiline' as const },
	{ dataIndex: 'reason', title: '操作原因' },
	{ dataIndex: 'created_duid', title: '操作者' },
	{ dataIndex: 'owner_uid', title: '作用账号' },
	{ dataIndex: 'status', title: '状态', options: statusOptions },
	{ dataIndex: 'request_hostname', title: '操作域名' },
	{ dataIndex: 'request_path', title: '操作接口' },
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
	request_hostname: row.request_hostname,
	request_path: row.request_path,
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
		const filters: SqlCondition[] = [];
		// 参数缺失用默认值；选了「全部」或传空串都表示不过滤。
		// 客户端首次请求发出时还没带上查询默认值——它拿到 schema 之后才填，而那一步
		// 刻意跳过了重新请求（避免首屏两次请求）。默认值因此要由服务端认。
		const status = (c.req.query('status') ?? DEFAULT_STATUS).trim();
		if (status !== ALL_STATUS && statusOptions.some((option) => option.value === status)) filters.push({ column: 'status', value: status });
		const tableFilter = c.req.query('table_name')?.trim();
		if (tableFilter) filters.push({ column: 'table_name', value: tableFilter });
		const rowFilter = c.req.query('row_id')?.trim();
		if (rowFilter) filters.push({ column: 'row_id', value: rowFilter });
		const reason = c.req.query('reason')?.trim();
		const rows = await listAuditEntries(database, filters, reason, undefined, tableSort(c));
		// 列表有条数上限，总数单独计一次——拿列表长度当总数会在超过上限时谎报。
		const totalRecords = await countAuditEntries(database, filters, reason);
		return apiResponse(c, 200, { table: {
			// 审计记录不可修改、不可删除，接口层因此没有新增、编辑与删除入口（§7.3）。
			// 这一页的动作本身就是审批机制，不经过审批门：撤回、批准、驳回走的是
			// runSystemSql，勾「立即生效」不改变任何行为，因此显式关掉这个勾选框。
			// 操作原因仍然要收：它会写进审批意见、撤回理由或恢复理由。
			option: { rowKey: 'id', canSkipApproval: false, queryFields, actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 撤回不新开记录，而是把这一条翻到另一面；已撤回的再点一次就恢复。
				// 撤回与恢复是互斥的两个动作，一行上只显示其中适用的那个。
				toolbar: flipActions.map((action) => ({ key: action.key, label: `${action.label}选中记录`, confirm: action.confirm })),
				row: flipActions.map((action) => ({ key: action.key, label: action.label, confirm: action.confirm, visibleWhen: { field: 'status', values: [action.from] } })),
			} },
			columns,
			dataSource: rows.map(publicEntry),
			totalRecords,
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
