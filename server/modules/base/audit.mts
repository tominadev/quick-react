import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { createDatabaseConfigStore } from './config-store.mjs';
import { normalizeSiteSettings } from './site-settings.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSql, runSystemSql, sql, type SqlAuditAction, type SqlCondition, type SqlSortOption } from '@server/database/sql.mjs';
import { isHiddenValueColumn } from '@shared/audit-tables.mjs';

export type AuditChange = { before: unknown; after: unknown };
export type AuditChanges = Record<string, AuditChange>;
export type AuditEntryRow = {
	id: string;
	operation_id: string;
	reason: string;
	table_name: string;
	row_id: string;
	action: SqlAuditAction;
	changes: string;
	status: 'pending' | 'applied' | 'rejected' | 'reverted';
	reviewed_at: number | null;
	reviewed_duid: string | null;
	review_reason: string;
	reverted_at: number | null;
	restored_at: number | null;
	restored_duid: string | null;
	restore_reason: string;
	reverted_duid: string | null;
	revert_reason: string;
	created_at: number;
	created_duid: string | null;
	owner_uid: string | null;
};

const entryColumns = {
	id: { column: 'id', cast: 'text' as const },
	operation_id: 'operation_id',
	reason: 'reason',
	table_name: 'table_name',
	row_id: { column: 'row_id', cast: 'text' as const },
	action: 'action',
	changes: 'changes',
	status: 'status',
	reviewed_at: 'reviewed_at',
	reviewed_duid: { column: 'reviewed_duid', cast: 'text' as const },
	review_reason: 'review_reason',
	restored_at: 'restored_at',
	restored_duid: { column: 'restored_duid', cast: 'text' as const },
	restore_reason: 'restore_reason',
	reverted_at: 'reverted_at',
	reverted_duid: { column: 'reverted_duid', cast: 'text' as const },
	revert_reason: 'revert_reason',
	created_at: 'created_at',
	created_duid: { column: 'created_duid', cast: 'text' as const },
	owner_uid: { column: 'owner_uid', cast: 'text' as const },
};

export const parseAuditChanges = (value: unknown): AuditChanges => {
	if (typeof value !== 'string' || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AuditChanges : {};
	} catch { return {}; }
};

/** 数组与对象按 JSON 显示：`String(['a','b'])` 得到 `a,b`，看不出它本来是个数组。 */
const displayValue = (value: unknown) => value === null || value === undefined ? '空'
	: typeof value === 'object' ? JSON.stringify(value) : String(value);

/**
 * 凭证列照常记录、照常撤回，只是**接口不返回它的前后值**：撤回由服务端直接写回，
 * 不需要任何人看见它（见需求文档 §5）。脱敏发生在这里，不在存储层。
 */
export const publicAuditChanges = (changes: AuditChanges) => Object.fromEntries(Object.entries(changes).map(([column, change]) => [
	column,
	isHiddenValueColumn(column) ? { hidden: true } : { before: change.before ?? null, after: change.after ?? null },
]));

/** 一列一行：多列一起改时挤在一行要靠眼睛找箭头，列表用 multiline 模式渲染。 */
export const describeAuditChanges = (changes: AuditChanges) => Object.entries(changes)
	.map(([column, change]) => isHiddenValueColumn(column) ? `${column}：已变更` : `${column}：${displayValue(change.before)} → ${displayValue(change.after)}`)
	.join('\n');

/**
 * 可见性由公共层的归属判定自动收敛，这里不再叠加条件。
 *
 * `reasonKeyword` 走模糊匹配：操作原因是人写的自由文本，等值匹配没有意义。
 */
export const listAuditEntries = async (database: DatabaseAdapter, where: SqlCondition[] = [], reasonKeyword?: string, limit = 200, sort?: SqlSortOption) => allSql<AuditEntryRow>(database, sql({ database }).select({
	table: AUDIT_TABLE,
	columns: entryColumns,
	sort,
	// 关键字直接当模式片段用：`%` 与 `_` 在这里就是通配符。转义需要 ESCAPE 子句，
	// 三种方言的默认转义字符并不一致，为一个搜索框引入那套规则不划算。
	where: [...where, ...(reasonKeyword ? [{ column: 'reason', operator: 'LIKE' as const, value: `%${reasonKeyword}%` }] : [])],
	// 审计列表最常看的是"刚刚发生了什么"；升序分页还会因新记录插入头部而错位（§8）。
	orderBy: [{ column: 'created_at', direction: 'DESC' }, { column: 'id', direction: 'DESC' }],
	limit,
}));

export const readAuditEntry = (database: DatabaseAdapter, id: string) => firstSql<AuditEntryRow>(database, sql({ database }).select({
	table: AUDIT_TABLE,
	columns: entryColumns,
	where: [{ column: 'id', value: id }],
}));

export type AuditRevertResult = { id: string; ok: boolean; message: string };
export type AuditStatus = AuditEntryRow['status'];

/** 允许的状态迁移，其余一概拒绝。 */
const TRANSITIONS: Record<AuditStatus, { to: AuditStatus; label: string }[]> = {
	pending: [{ to: 'applied', label: '批准' }, { to: 'rejected', label: '驳回' }],
	applied: [{ to: 'reverted', label: '撤回' }],
	reverted: [{ to: 'applied', label: '恢复' }],
	rejected: [],
};

/**
 * 状态迁移：撤回、恢复、批准、驳回是同一段代码。
 *
 * 一次变更**永远只有一条记录**：`changes` 里同时有前值和后值，`status` 说明当前停在哪一边。
 * 写哪一侧只看目标状态——落到 `applied` 就写 `after`、校验 `before`；落到 `reverted` 就反过来。
 * 批准（`pending → applied`）与恢复（`reverted → applied`）因此是同一条路径：两种情况下
 * 行上都还是 `before`，都要写成 `after`。驳回不碰数据，只落状态。
 */
const transitionOne = async (database: DatabaseAdapter, entry: AuditEntryRow, to: AuditStatus, reason: string): Promise<AuditRevertResult> => {
	const allowed = TRANSITIONS[entry.status].find((transition) => transition.to === to);
	if (!allowed) return { id: entry.id, ok: false, message: `当前状态是「${STATUS_LABELS[entry.status]}」，不能执行这个操作` };
	// 三种迁移各写自己那一组：同一条记录可能先被批准、再被撤回、又被恢复，
	// 合用一组的话后发生的会覆盖先发生的——恢复完之后「撤回人」就成了恢复的人。
	const now = Date.now(), actor = actorOf(database);
	const statusFields = entry.status === 'pending'
		? { reviewed_at: now, reviewed_duid: actor, review_reason: reason }
		: to === 'reverted'
			? { reverted_at: now, reverted_duid: actor, revert_reason: reason }
			: { restored_at: now, restored_duid: actor, restore_reason: reason };
	// 驳回不碰数据：待审批的修改从未写入过。
	if (to !== 'rejected') {
		const changes = parseAuditChanges(entry.changes);
		const columns = Object.keys(changes);
		if (!columns.length) return { id: entry.id, ok: false, message: '该记录没有可还原的字段' };
		const toApplied = to === 'applied';
		const write = (column: string) => toApplied ? changes[column].after : changes[column].before;
		const expect = (column: string) => toApplied ? changes[column].before : changes[column].after;
		// 每一列都要求当前值仍等于迁移前那一侧，也就是这一列之后没有被人动过（§7.2）。
		// 期望值为 NULL 时必须写成 IS NULL：SQL 里 col = NULL 求值为 unknown，永远不匹配。
		const where: SqlCondition[] = [
			{ column: 'id', value: entry.row_id },
			...columns.map((column): SqlCondition => {
				const value = expect(column);
				return value === null || value === undefined ? { column, operator: 'IS NULL' } : { column, value };
			}),
		];
		const values = Object.fromEntries(columns.map((column) => [column, write(column) ?? null]));
		// 不走 runOperation：这次迁移的留痕就是原记录上的状态，不该再开一条，更不该再排一次队。
		const result = await runSystemSql(database, sql({ database }).revert(entry.table_name, values, where));
		if (Number(result.meta?.changes ?? 0) === 0) {
			return { id: entry.id, ok: false, message: `该记录已被后续修改覆盖，无法${allowed.label}` };
		}
	}
	// 带上原状态做条件：并发下只有一个请求能迁移成功。
	// 走 runSystemSql：这次迁移的留痕就是这几列本身，再记一条是重复；
	// 递归也是被这条路径挡住的，审计表因此不需要被排除在受管范围之外。
	await runSystemSql(database, sql({ database }).update(AUDIT_TABLE, { status: to, ...statusFields },
		[{ column: 'id', value: entry.id }, { column: 'status', value: entry.status }]));
	return { id: entry.id, ok: true, message: `已${allowed.label}` };
};

const actorOf = (database: DatabaseAdapter) => database.actorUidForTable?.(AUDIT_TABLE) ?? database.actorUid ?? null;

export const STATUS_LABELS: Record<AuditStatus, string> = { pending: '待审批', applied: '已生效', rejected: '已驳回', reverted: '已撤回' };

/**
 * 批量迁移是逐条执行的入口，**不是原子的级联回滚**——无事务环境下做不到。
 *
 * 执行顺序必须在实现里重排，不能沿用列表的显示顺序（§8）：同一列经历 A → B → C 后
 * 当前值是 C，只有先撤 B→C 才能接着撤 A→B。落到 applied 的方向正好相反，按时间升序走。
 * 某一条被拒绝时其余照常执行，最后逐条返回结果。
 */
export const transitionAuditEntries = async (database: DatabaseAdapter, ids: readonly string[], to: AuditStatus, reason = ''): Promise<AuditRevertResult[]> => {
	const entries: AuditEntryRow[] = [];
	const results: AuditRevertResult[] = [];
	for (const id of ids) {
		const entry = await readAuditEntry(database, id);
		if (entry) entries.push(entry);
		else results.push({ id, ok: false, message: '审计记录不存在或无权访问' });
	}
	const newestFirst = (left: AuditEntryRow, right: AuditEntryRow) => Number(right.created_at) - Number(left.created_at) || Number(right.id) - Number(left.id);
	entries.sort(to === 'reverted' ? newestFirst : (left, right) => newestFirst(right, left));
	for (const entry of entries) results.push(await transitionOne(database, entry, to, reason));
	return results;
};

export type AuditPurgeOptions = { tenantId?: string | number | bigint; batchSize?: number; maxBatches?: number };

/**
 * 到期记录**物理删除**：审计表只增不减，必须有保留期（§10）。
 *
 * 分批进行且可重入：每批取一页 ID 再逐条删除，中途失败下次接着删，不依赖事务。
 * 以系统上下文运行（subjectRoles 为 null），否则清理任务会被自己的可见性判定挡住。
 */
export const purgeExpiredAuditEntries = async (database: DatabaseAdapter, retentionDays: number, options: AuditPurgeOptions = {}) => {
	const days = Math.trunc(Number(retentionDays) || 0);
	if (days <= 0) return 0;
	const cutoff = Date.now() - days * 86_400_000;
	const batchSize = options.batchSize ?? 500, maxBatches = options.maxBatches ?? 20;
	const scope: SqlCondition[] = [
		{ column: 'created_at', operator: '<', value: cutoff },
		...(options.tenantId === undefined ? [] : [{ column: 'owner_tid', value: options.tenantId }]),
	];
	let removed = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const rows = await allSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: AUDIT_TABLE, columns: { id: { column: 'id', cast: 'text' } }, where: scope, deleted: 'all',
			orderBy: [{ column: 'id', direction: 'ASC' }], limit: batchSize,
		}));
		if (!rows.length) break;
		for (const row of rows) {
			await runSql(database, sql({ database, subjectRoles: null }).delete(AUDIT_TABLE, [{ column: 'id', value: row.id }]));
			removed += 1;
		}
		if (rows.length < batchSize) break;
	}
	return removed;
};

/** 保留期按租户独立，因此逐个租户读自己的站点设置再清理；读不到就用代码里的默认值。 */
export const purgeAuditRetention = async (database: DatabaseAdapter) => {
	const tenants = await allSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'base_tenants', columns: { id: { column: 'id', cast: 'text' } }, deleted: 'all',
	}));
	let removed = 0;
	for (const tenant of tenants) {
		const settings = normalizeSiteSettings(await createDatabaseConfigStore(withDatabaseActors(database, { subjectRoles: null }), tenant.id).get('site-settings'));
		removed += await purgeExpiredAuditEntries(database, settings.auditRetentionDays, { tenantId: tenant.id });
	}
	return removed;
};
