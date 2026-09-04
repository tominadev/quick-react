import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { createDatabaseConfigStore } from './config-store.mjs';
import { normalizeSiteSettings } from './site-settings.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSql, runSystemSql, sql, type SqlAuditAction, type SqlCondition } from '@server/database/sql.mjs';
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
	status: 'applied' | 'reverted';
	reverted_at: number | null;
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

const displayValue = (value: unknown) => value === null || value === undefined ? '空' : String(value);

/**
 * 凭证列照常记录、照常撤回，只是**接口不返回它的前后值**：撤回由服务端直接写回，
 * 不需要任何人看见它（见需求文档 §5）。脱敏发生在这里，不在存储层。
 */
export const publicAuditChanges = (changes: AuditChanges) => Object.fromEntries(Object.entries(changes).map(([column, change]) => [
	column,
	isHiddenValueColumn(column) ? { hidden: true } : { before: change.before ?? null, after: change.after ?? null },
]));

export const describeAuditChanges = (changes: AuditChanges) => Object.entries(changes)
	.map(([column, change]) => isHiddenValueColumn(column) ? `${column}：已变更` : `${column}：${displayValue(change.before)} → ${displayValue(change.after)}`)
	.join('；');

/** 可见性由公共层的归属判定自动收敛，这里不再叠加条件。 */
export const listAuditEntries = async (database: DatabaseAdapter, where: SqlCondition[] = [], limit = 200) => allSql<AuditEntryRow>(database, sql({ database }).select({
	table: AUDIT_TABLE,
	columns: entryColumns,
	where,
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

/**
 * 撤回**不产生新的审计记录**，而是把这一条翻到另一面。
 *
 * 一次变更永远只有一条记录：`changes` 里同时有前值和后值，`status` 说明当前停在哪一边。
 * 撤回错了就再翻回来（reverted → applied），不会堆出一串互相指向的记录。
 *
 * 但只翻 status 不够：原记录的 created_duid、created_at、reason 属于**原操作者**，
 * 不能拿来表示"谁在什么时候把它撤了"。撤回的操作者、时间与理由另存三列；审批用另一组 reviewed_*。
 *
 * 代价是**只留最后一次翻转**：反复撤回又恢复的过程不保留，见需求文档 §14。
 */
const flipOne = async (database: DatabaseAdapter, entry: AuditEntryRow, reason: string): Promise<AuditRevertResult> => {
	const changes = parseAuditChanges(entry.changes);
	const columns = Object.keys(changes);
	if (!columns.length) return { id: entry.id, ok: false, message: '该记录没有可还原的字段' };
	const reverting = entry.status === 'applied';
	// 撤回写回 before、校验 after；恢复正好相反。除了方向，两者是同一段代码。
	const target = (column: string) => reverting ? changes[column].before : changes[column].after;
	const expected = (column: string) => reverting ? changes[column].after : changes[column].before;
	const values = Object.fromEntries(columns.map((column) => [column, target(column) ?? null]));
	// 每一列都要求"当前值仍等于翻转前那一侧的值"，也就是这一列之后没有被人动过（§7.2）。
	// 期望值为 NULL 时必须写成 IS NULL：SQL 里 col = NULL 求值为 unknown，永远不匹配。
	const where: SqlCondition[] = [
		{ column: 'id', value: entry.row_id },
		...columns.map((column): SqlCondition => {
			const value = expected(column);
			return value === null || value === undefined ? { column, operator: 'IS NULL' } : { column, value };
		}),
	];
	// 不走 runOperation：这次翻转的留痕就是原记录上的 status，不该再开一条。
	const result = await runSystemSql(database, sql({ database }).revert(entry.table_name, values, where));
	if (Number(result.meta?.changes ?? 0) === 0) {
		return { id: entry.id, ok: false, message: `该记录已被后续修改覆盖，无法${reverting ? '撤回' : '恢复'}` };
	}
	// 带上原状态做条件：并发下只有一个请求能翻成功。
	await runSql(database, sql({ database }).update(AUDIT_TABLE, {
		status: reverting ? 'reverted' : 'applied',
		reverted_at: Date.now(),
		reverted_duid: database.actorUidForTable?.(AUDIT_TABLE) ?? database.actorUid ?? null,
		revert_reason: reason,
	}, [{ column: 'id', value: entry.id }, { column: 'status', value: entry.status }]));
	return { id: entry.id, ok: true, message: reverting ? '已撤回' : '已恢复' };
};

/**
 * 多选撤回是逐条执行的批量入口，**不是原子的级联回滚**——无事务环境下做不到。
 *
 * 执行顺序必须在实现里重排，不能沿用列表的显示顺序（§8）：同一列经历 A → B → C 后
 * 当前值是 C，只有先撤 B→C 才能接着撤 A→B。恢复方向相反，因此按时间升序走。
 * 某一条被拒绝时其余照常执行，最后逐条返回结果。
 */
export const revertAuditEntries = async (database: DatabaseAdapter, ids: readonly string[], reason = '', expect?: AuditEntryRow['status']): Promise<AuditRevertResult[]> => {
	const entries: AuditEntryRow[] = [];
	const missing: AuditRevertResult[] = [];
	for (const id of ids) {
		const entry = await readAuditEntry(database, id);
		if (!entry) { missing.push({ id, ok: false, message: '审计记录不存在或无权访问' }); continue; }
		// 界面上「撤回」和「恢复」是两个按钮，各自只对一种状态有意义。带上期望状态，
		// 列表过期时点到的那一条会被拒绝，而不是被翻成与按钮相反的方向。
		if (expect && entry.status !== expect) {
			missing.push({ id, ok: false, message: expect === 'applied' ? '该记录已经撤回过' : '该记录当前是已生效状态' });
			continue;
		}
		entries.push(entry);
	}
	const newestFirst = (left: AuditEntryRow, right: AuditEntryRow) => Number(right.created_at) - Number(left.created_at) || Number(right.id) - Number(left.id);
	const reverting = entries.filter((entry) => entry.status === 'applied').sort(newestFirst);
	const restoring = entries.filter((entry) => entry.status === 'reverted').sort((left, right) => newestFirst(right, left));
	const results: AuditRevertResult[] = [];
	for (const entry of [...reverting, ...restoring]) results.push(await flipOne(database, entry, reason));
	return [...results, ...missing];
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
