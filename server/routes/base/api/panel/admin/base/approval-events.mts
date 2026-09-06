import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, sql, type SqlCondition } from '@server/database/sql.mjs';
import { APPROVAL_EVENT_TABLE, eventLabel, type ApprovalTransition } from '@server/modules/base/audit.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

/**
 * 处理经过：一条审批记录上发生过的每一次迁移。
 *
 * **不叫「审批历史」**——这里六种事件只有两种是审批（批准、驳回），另外四种是撤销、恢复、
 * 回滚、重新应用；叫审批历史会让人以为回滚不在里面。审批页列表上那一列叫「最近处理」，
 * 点开就是「处理经过」，两处对得上。
 *
 * 这一页**只读**：事件只追加不修改，改一条已经发生的处理经过等于篡改证据。
 *
 * 因此**不声明 `tableCrud`**——那个声明会让公共层自动挂上回收站入口、还原/彻底删除，
 * 以及整套撤销/批准/驳回的行按钮。一张只能读的表要那些没有意义，摆出来只会让人以为
 * 处理经过是可以改的。保留期清理连着主记录一起删（见 purgeExpiredAuditEntries）。
 */
/** 与审批页的动作颜色对齐：装回去的绿、拆下来的红、动数据的青/蓝。 */
const KIND_COLORS: Record<ApprovalTransition, string> = {
	approve: 'green', reject: 'red', withdraw: 'default',
	requeue: 'gold', revert: 'volcano', redo: 'cyan',
};

const kindOptions = (['withdraw', 'approve', 'reject', 'requeue', 'revert', 'redo'] as const)
	.map((kind) => ({ value: kind, text: eventLabel(kind), color: KIND_COLORS[kind] }));

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'created_duid', title: '操作者', emptyText: '系统' },
	{ dataIndex: 'approval_id', title: '审批记录', dataType: 'int' as const },
	{ dataIndex: 'kind', title: '处理类型', options: kindOptions },
	{ dataIndex: 'reason', title: '理由' }];

const queryFields = [
	{ dataIndex: 'approval_id', label: '审批记录', component: 'textbox' as const, placeholder: '审批记录的 ID' },
	{ dataIndex: 'kind', label: '处理类型', component: 'select' as const, defaultValue: '', options: [{ value: '', text: '全部' }, ...kindOptions] },
];

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	const database = c.get('database');
	const approvalId = c.req.query('approval_id')?.trim();
	const kind = c.req.query('kind')?.trim();
	const where: SqlCondition[] = [
		...(approvalId ? [{ column: 'approval_id', value: approvalId }] : []),
		...(kind && kindOptions.some((option) => option.value === kind) ? [{ column: 'kind', value: kind }] : []),
	];
	const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
		table: APPROVAL_EVENT_TABLE,
		columns: { id: { column: 'id', cast: 'text' }, created_at: 'created_at', created_duid: { column: 'created_duid', cast: 'text' }, approval_id: { column: 'approval_id', cast: 'text' }, kind: 'kind', reason: 'reason' },
		where, sort: tableSort(c), orderBy: [{ column: 'id', direction: 'DESC' }], limit: 200,
	}));
	return apiResponse(c, 200, { table: {
		// 只读：没有新增、编辑、删除，也不给回收站。
		option: { rowKey: 'id', queryFields, actions: { query: [{ key: 'search', label: '搜索' }] } },
		columns,
		// 原样发下去：谁做的没有 duid 就是机器写的，理由为空是撤销那一类本来就不需要理由。
		dataSource: rows,
		totalRecords: rows.length,
	} });
};

export default handler;
