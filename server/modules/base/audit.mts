import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import { runOperation } from './operation.mjs';
import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { createDatabaseConfigStore } from './config-store.mjs';
import { normalizeSiteSettings } from './site-settings.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSql, sql, type SqlAuditAction, type SqlCondition } from '@server/database/sql.mjs';
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

/** update 的逆操作是把前值写回；软删除与恢复只是碰的列恰好是 deleted_at（§7.1）。 */
const inverseAction = (action: SqlAuditAction): SqlAuditAction => action === 'soft_delete' ? 'restore' : action === 'restore' ? 'soft_delete' : 'update';

export type AuditRevertResult = { id: string; ok: boolean; message: string };

const revertOne = async (c: Context<AppEnv>, database: DatabaseAdapter, entry: AuditEntryRow): Promise<AuditRevertResult> => {
	if (entry.status !== 'applied') return { id: entry.id, ok: false, message: '该记录已经撤回过' };
	const changes = parseAuditChanges(entry.changes);
	const columns = Object.keys(changes);
	if (!columns.length) return { id: entry.id, ok: false, message: '该记录没有可还原的字段' };
	const values = Object.fromEntries(columns.map((column) => [column, changes[column].before ?? null]));
	// 每一列都要求"当前值仍等于变更后的值"，也就是这一列自那次变更之后没有被人动过（§7.2）。
	// after 为 NULL 时必须写成 IS NULL：SQL 里 col = NULL 求值为 unknown，永远不匹配。
	const where: SqlCondition[] = [
		{ column: 'id', value: entry.row_id },
		...columns.map((column): SqlCondition => {
			const after = changes[column].after;
			return after === null || after === undefined ? { column, operator: 'IS NULL' } : { column, value: after };
		}),
	];
	// 撤回本身也是一次人工操作，因此走操作层——它会为这次撤回记下一条新的审计记录（§7.3）。
	const [result] = await runOperation(c, database, [sql({ database }).revert(entry.table_name, values, where)], { reason: `撤回审计记录 #${entry.id}` });
	if (Number(result.meta?.changes ?? 0) === 0) return { id: entry.id, ok: false, message: '该记录已被后续修改覆盖，无法撤回' };
	// status 是审计记录上唯一可变的字段，且只能从 applied 变成 reverted 一次。
	await runSql(database, sql({ database }).update(AUDIT_TABLE, { status: 'reverted' }, [{ column: 'id', value: entry.id }, { column: 'status', value: 'applied' }]));
	return { id: entry.id, ok: true, message: `已撤回：${inverseAction(entry.action)}` };
};

/**
 * 多选撤回是逐条执行的批量入口，**不是原子的级联回滚**——无事务环境下做不到。
 *
 * 执行顺序必须按 created_at 降序重排，不能沿用列表的显示顺序（§8）：同一列经历
 * A → B → C 后当前值是 C，只有先撤 B→C 才能接着撤 A→B。某一条被拒绝时其余照常执行。
 */
export const revertAuditEntries = async (c: Context<AppEnv>, database: DatabaseAdapter, ids: readonly string[]): Promise<AuditRevertResult[]> => {
	const entries: AuditEntryRow[] = [];
	const missing: AuditRevertResult[] = [];
	for (const id of ids) {
		const entry = await readAuditEntry(database, id);
		if (entry) entries.push(entry);
		else missing.push({ id, ok: false, message: '审计记录不存在或无权访问' });
	}
	entries.sort((left, right) => Number(right.created_at) - Number(left.created_at) || Number(right.id) - Number(left.id));
	const results: AuditRevertResult[] = [];
	for (const entry of entries) results.push(await revertOne(c, database, entry));
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
