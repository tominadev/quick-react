import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, sql, type SqlCondition } from '@server/database/sql.mjs';
import { AUDIT_APPROVAL_TABLE, kindLabel, type AuditApproval } from '@server/modules/base/audit.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

/**
 * 审批记录：一条审计记录被处理的每一次经过。
 *
 * 表 `base_audit_approvals`、路径 `audit/approvals`、页面「审批记录」——三层同一个词，
 * 读代码的人不必在两套说法之间换算。
 *
 * **这张表曾经叫 `base_audit_transitions`，页面叫「迁移记录」。** 换掉有两个理由：
 * 中文的「迁移」在这个库里已经是数据库 migration 的固定译法——建库脚本、迁移基线、
 * `test:database-migrations` 说的都是那个，`sql.mts` 里甚至有一张真的「迁移记录表」；
 * 而 transition 这个词只活在代码里，与菜单、页面上的说法从来对不上。
 *
 * 随之改变的是定位：这里记的是**审批过程**，不是状态机事件。六种动作都是这套审批系统
 * 提供的处理手段，撤销、回滚、重新应用也在其中——它们发生在批准之后，但仍然是同一套
 * 流程里的动作，与「批准」「驳回」并列在同一张表上才看得出一条记录的完整经过。
 *
 * **`kind` 里的 `approve` 只是六种动作之一**（中文「批准」），与表名说的「审批」不是
 * 一回事。中文这两个词分得开，英文 approve / approvals 同源，看 `kind` 的取值时不要
 * 按词形去推断范围。
 *
 * 这一页**只读**：事件只追加不修改，改一条已经发生的审批记录等于篡改证据。
 *
 * 因此**不声明 `tableCrud`**——那个声明会让公共层自动挂上回收站入口、还原/彻底删除，
 * 以及整套撤销/批准/驳回的行按钮。一张只能读的表要那些没有意义，摆出来只会让人以为
 * 审批记录是可以改的。保留期清理连着主记录一起删（见 purgeExpiredAuditEntries）。
 */
/** 与审批页的动作颜色对齐：装回去的绿、拆下来的红、动数据的青/蓝。 */
const KIND_COLORS: Record<AuditApproval, string> = {
	approve: 'green', reject: 'red', withdraw: 'default',
	requeue: 'gold', revert: 'volcano', redo: 'cyan',
};

const kindOptions = (['withdraw', 'approve', 'reject', 'requeue', 'revert', 'redo'] as const)
	.map((kind) => ({ value: kind, text: kindLabel(kind), color: KIND_COLORS[kind] }));

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'created_duid', title: '操作者', emptyText: '系统' },
	{ dataIndex: 'audit_id', title: '审计记录', dataType: 'int' as const },
	{ dataIndex: 'kind', title: '审批动作', options: kindOptions },
	{ dataIndex: 'reason', title: '理由' }];

const queryFields = [
	{ dataIndex: 'audit_id', label: '审计记录', component: 'textbox' as const, placeholder: '审计记录的 ID' },
	// 不摆「全部」：空着就是不筛这一项（与审计页同一套说法）。
	{ dataIndex: 'kind', label: '审批动作', component: 'select' as const, options: kindOptions },
];

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	const database = c.get('database');
	const builder = sql({ database });
	const kind = c.req.query('kind')?.trim();
	const where: SqlCondition[] = [
		...builder.search('audit_id', c.req.query('audit_id')?.trim()),
		...(kind && kindOptions.some((option) => option.value === kind) ? [{ column: 'kind', value: kind }] : []),
	];
	const rows = await allSql<Record<string, unknown>>(database, builder.select({
		table: AUDIT_APPROVAL_TABLE,
		columns: { id: { column: 'id', cast: 'text' }, created_at: 'created_at', created_duid: { column: 'created_duid', cast: 'text' }, audit_id: { column: 'audit_id', cast: 'text' }, kind: 'kind', reason: 'reason' },
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
