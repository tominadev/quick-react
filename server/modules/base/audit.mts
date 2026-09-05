import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { createDatabaseConfigStore } from './config-store.mjs';
import { CONFIG_TABLE, invalidateConfigurationCache } from './configuration-cache.mjs';
import { normalizeSiteSettings } from './site-settings.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSql, runSystemSql, sql, type SqlAuditAction, type SqlCondition, type SqlSortOption } from '@server/database/sql.mjs';
import { isHiddenValueColumn, isHiddenValueKey } from '@shared/audit-tables.mjs';

export type AuditChange = { before: unknown; after: unknown };
export type AuditChanges = Record<string, AuditChange>;
export type AuditEntryRow = {
	id: string;
	operation_id: string;
	reason: string;
	request_hostname: string;
	request_path: string;
	table_name: string;
	row_id: string;
	action: SqlAuditAction;
	changes: string;
	status: 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'reverted';
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
	request_hostname: 'request_hostname',
	request_path: 'request_path',
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

const plainObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 存进 JSON 列的值回读时是文本，写入那一刻还是对象，两种都要认。 */
const asObject = (value: unknown): Record<string, unknown> | undefined => {
	if (plainObject(value)) return value;
	if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined;
	try { const parsed: unknown = JSON.parse(value); return plainObject(parsed) ? parsed : undefined; }
	catch { return undefined; }
};

/**
 * JSON 列按**键**求差异：改了哪个键就只列哪个键。
 *
 * 整块 JSON 一起显示时，改一个页脚会甩出整个站点配置，「改了什么」等于没答。逐键之后
 * 还有一层收益：`base_configs.value` 原先因为「整块里混着 OIDC 客户端密钥，无法逐列
 * 区分」而整列隐藏，现在能只藏掉密钥那几个键，其余照常可见。
 *
 * 嵌套对象继续往下拆，路径用点连接；数组整体比较——数组的差异是位置和顺序的问题，
 * 拆成下标反而更难读。
 */
const jsonDiff = (before: Record<string, unknown>, after: Record<string, unknown>, prefix = ''): Array<{ path: string; before: unknown; after: unknown }> => {
	const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return paths.flatMap((key) => {
		const path = prefix ? `${prefix}.${key}` : key;
		const left = before[key];
		const right = after[key];
		if (plainObject(left) && plainObject(right)) return jsonDiff(left, right, path);
		if (JSON.stringify(left ?? null) === JSON.stringify(right ?? null)) return [];
		return [{ path, before: left, after: right }];
	});
};

/**
 * 一列的变更摊平成「路径 → 前后值」。JSON 列摊成逐键，其余保持整列一条。
 *
 * 键名也走 isHiddenValueColumn：JSON 里的 `clientSecret`、`password` 与同名的列一样
 * 不该显示，脱敏规则只有一套。
 */
const flattenChange = (column: string, change: { before?: unknown; after?: unknown }) => {
	// 整列隐藏的列**绝不展开**：password 也是 JSON 列，逐键拆开就等于把
	// password.hash 明明白白写在页面上。隐藏与否先在最外层定死。
	if (isHiddenValueColumn(column)) return [{ path: column, before: change.before, after: change.after, hidden: true }];
	const before = asObject(change.before);
	const after = asObject(change.after);
	if (!before || !after) return [{ path: column, before: change.before, after: change.after, hidden: false }];
	const diff = jsonDiff(before, after);
	// 两侧都是对象却比不出差异（例如只是键序不同）：仍要留一条，否则记录看起来像什么都没改。
	if (!diff.length) return [{ path: column, before: change.before, after: change.after, hidden: false }];
	return diff.map((item) => ({
		path: `${column}.${item.path}`,
		before: item.before,
		after: item.after,
		hidden: item.path.split('.').some((key) => isHiddenValueKey(key)),
	}));
};

const flattenChanges = (changes: AuditChanges) => Object.entries(changes).flatMap(([column, change]) => flattenChange(column, change));

/**
 * 凭证列照常记录、照常撤回，只是**接口不返回它的前后值**：撤回由服务端直接写回，
 * 不需要任何人看见它（见需求文档 §5）。脱敏发生在这里，不在存储层。
 */
export const publicAuditChanges = (changes: AuditChanges) => Object.fromEntries(flattenChanges(changes).map((item) => [
	item.path,
	item.hidden ? { hidden: true } : { before: item.before ?? null, after: item.after ?? null },
]));

/** 一列一行：多列一起改时挤在一行要靠眼睛找箭头，列表用 multiline 模式渲染。 */
export const describeAuditChanges = (changes: AuditChanges) => flattenChanges(changes)
	.map((item) => item.hidden ? `${item.path}：已变更` : `${item.path}：${displayValue(item.before)} → ${displayValue(item.after)}`)
	.join('\n');

/**
 * 可见性由公共层的归属判定自动收敛，这里不再叠加条件。
 *
 * `reasonKeyword` 走模糊匹配：操作原因是人写的自由文本，等值匹配没有意义。
 */
/**
 * 符合条件的记录**总数**，与 listAuditEntries 用同一组条件。
 *
 * 列表有 200 条上限，拿它的长度当总数会在超过上限时谎报（库里 250 条却显示「共 200 条」）。
 * 计数单独查一次。
 */
export const countAuditEntries = async (database: DatabaseAdapter, where: SqlCondition[] = [], reasonKeyword?: string) => {
	const row = await firstSql<{ count: number }>(database, sql({ database }).count(AUDIT_TABLE, [
		...where,
		...(reasonKeyword ? [{ column: 'reason', operator: 'LIKE' as const, value: `%${reasonKeyword}%` }] : []),
	]));
	return Number(row?.count ?? 0);
};

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

/**
 * 允许的状态迁移，其余一概拒绝。
 *
 * 「撤销申请」与「撤回变更」按对象区分，不靠词义：前者收回的是还没生效的申请
 * （从 pending 出发，数据从未动过），后者回滚的是已经生效的变更（从 applied 出发，
 * 数据要改回去）。两者的起点、后果和权限都不同，合成一个动作只会让人分不清点了什么。
 */
const TRANSITIONS: Record<AuditStatus, { to: AuditStatus; label: string }[]> = {
	pending: [{ to: 'applied', label: '批准' }, { to: 'rejected', label: '驳回' }, { to: 'withdrawn', label: '撤销申请' }],
	applied: [{ to: 'reverted', label: '回滚' }],
	reverted: [{ to: 'applied', label: '恢复' }],
	rejected: [],
	withdrawn: [],
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
	// 三种迁移各写自己那一组：同一条记录可能先被批准、再被回滚、又被恢复，
	// 合用一组的话后发生的会覆盖先发生的——恢复完之后「撤回人」就成了恢复的人。
	const now = Date.now(), actor = actorOf(database);
	// 撤销申请是申请人自己收回，写进「审批」那一组：这一格回答的是「谁把这条从队列里
	// 拿掉的、为什么」，申请人自己拿掉也是这个问题的答案之一。
	const statusFields = entry.status === 'pending'
		? { reviewed_at: now, reviewed_duid: actor, review_reason: reason }
		: to === 'reverted'
			? { reverted_at: now, reverted_duid: actor, revert_reason: reason }
			: { restored_at: now, restored_duid: actor, restore_reason: reason };
	// 驳回与撤销申请都不碰数据：待审批的修改从未写入过。
	if (to !== 'rejected' && to !== 'withdrawn') {
		const changes = parseAuditChanges(entry.changes);
		const columns = Object.keys(changes);
		if (!columns.length) return { id: entry.id, ok: false, message: '该记录没有可还原的字段' };
		const toApplied = to === 'applied';
		const write = (column: string) => toApplied ? changes[column].after : changes[column].before;
		const expect = (column: string) => toApplied ? changes[column].before : changes[column].after;
		// JSON 列记的是差异（只有变了的那几个键），写回时要合并进当前值——整块覆盖会把
		// 这条记录没提到的键一起抹掉。读一次当前行，合并出目标值，并用**读到的整值**
		// 作为并发条件：读—改—写之间被人插一手，条件就匹配不上，写入落空。
		const merged = new Map<string, { expect: unknown; write: unknown }>();
		const partial = columns.filter((column) => plainObject(expect(column)) || plainObject(write(column)));
		if (partial.length) {
			const current = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
				table: entry.table_name,
				columns: Object.fromEntries(partial.map((column) => [column, column])),
				where: [{ column: 'id', value: entry.row_id }],
				deleted: 'all',
			}));
			if (!current) return { id: entry.id, ok: false, message: `原记录已不存在，无法${allowed.label}` };
			for (const column of partial) {
				const value = asObject(current[column]);
				if (!value) return { id: entry.id, ok: false, message: `该记录已被后续修改覆盖，无法${allowed.label}` };
				// 这条记录提到的每个键，当前值都必须还停在迁移前那一侧；别的键随便别人怎么改。
				const from = asObject(expect(column)) ?? {};
				for (const [key, expected] of Object.entries(from)) {
					if (JSON.stringify(value[key] ?? null) !== JSON.stringify(expected ?? null)) {
						return { id: entry.id, ok: false, message: `该记录已被后续修改覆盖，无法${allowed.label}` };
					}
				}
				// 按当前值的键序重建，只替换这条记录提到的键：JSON 的键序本无语义，但保持稳定
				// 能让存储和后续 diff 都可读，也免得每次撤回都把整行的文本形态搅一遍。
				const replacement = asObject(write(column)) ?? {};
				const target: Record<string, unknown> = {};
				for (const [key, existing] of Object.entries(value)) {
					if (key in replacement) target[key] = replacement[key];
					else if (!(key in from)) target[key] = existing;
				}
				for (const [key, next] of Object.entries(replacement)) if (!(key in target)) target[key] = next;
				merged.set(column, { expect: current[column], write: target });
			}
		}
		// 每一列都要求当前值仍等于迁移前那一侧，也就是这一列之后没有被人动过（§7.2）。
		// 期望值为 NULL 时必须写成 IS NULL：SQL 里 col = NULL 求值为 unknown，永远不匹配。
		const where: SqlCondition[] = [
			{ column: 'id', value: entry.row_id },
			...columns.map((column): SqlCondition => {
				const value = merged.has(column) ? merged.get(column)!.expect : expect(column);
				return value === null || value === undefined ? { column, operator: 'IS NULL' } : { column, value };
			}),
		];
		const values = Object.fromEntries(columns.map((column) => [column, (merged.has(column) ? merged.get(column)!.write : write(column)) ?? null]));
		// 不走 runOperation：这次迁移的留痕就是原记录上的状态，不该再开一条，更不该再排一次队。
		const result = await runSystemSql(database, sql({ database }).revert(entry.table_name, values, where));
		if (Number(result.meta?.changes ?? 0) === 0) {
			return { id: entry.id, ok: false, message: `该记录已被后续修改覆盖，无法${allowed.label}` };
		}
		// 审批通过是直接把值写回表的，绕过了 configStore 那条会清缓存的路；不清的话
		// 批准完页面还显示旧值，看起来像批准没生效。
		if (entry.table_name === CONFIG_TABLE) invalidateConfigurationCache();
	}
	// 带上原状态做条件：并发下只有一个请求能迁移成功。
	// 走 runSystemSql：这次迁移的留痕就是这几列本身，再记一条是重复；
	// 递归也是被这条路径挡住的，审计表因此不需要被排除在受管范围之外。
	await runSystemSql(database, sql({ database }).update(AUDIT_TABLE, { status: to, ...statusFields },
		[{ column: 'id', value: entry.id }, { column: 'status', value: entry.status }]));
	return { id: entry.id, ok: true, message: `已${allowed.label}` };
};

const actorOf = (database: DatabaseAdapter) => database.actorUidForTable?.(AUDIT_TABLE) ?? database.actorUid ?? null;

export const STATUS_LABELS: Record<AuditStatus, string> = { pending: '待审批', applied: '已生效', rejected: '已驳回', withdrawn: '已撤销申请', reverted: '已回滚' };

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
