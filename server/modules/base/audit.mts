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
	row_key: string;
	action: SqlAuditAction;
	changes: string;
	review_status: ReviewStatus;
	data_status: DataStatus;
	scope: 'admin' | 'self';
	reviewed_at: number | null;
	reviewed_duid: string | null;
	review_reason: string;
	withdrawn_at: number | null;
	withdrawn_duid: string | null;
	reverted_at: number | null;
	reapplied_at: number | null;
	reapplied_duid: string | null;
	reapply_reason: string;
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
	row_key: 'row_key',
	action: 'action',
	changes: 'changes',
	review_status: 'review_status',
	data_status: 'data_status',
	scope: 'scope',
	reviewed_at: 'reviewed_at',
	reviewed_duid: { column: 'reviewed_duid', cast: 'text' as const },
	review_reason: 'review_reason',
	withdrawn_at: 'withdrawn_at',
	withdrawn_duid: { column: 'withdrawn_duid', cast: 'text' as const },
	reapplied_at: 'reapplied_at',
	reapplied_duid: { column: 'reapplied_duid', cast: 'text' as const },
	reapply_reason: 'reapply_reason',
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
 * 凭证列照常记录、照常回滚，只是**接口不返回它的前后值**：回滚由服务端直接写回，
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

/**
 * 「要处理的这条申请」用的构造器：审批表一律按 active 读。
 *
 * 适配器上的 deletedScope 说的是**正在浏览的那张表**。在某张业务表的回收站里点「立即批准」
 * 时它是 deleted，于是这些查询会跑去「已删除的审批记录」里找，一条都找不到——界面报
 * 「审计记录不存在或无权访问」。审批页自己的列表(listAuditEntries)不在此列：那一页浏览的
 * 就是这张表，它的回收站视图是真要看已删除的审批记录。
 */
const approvalSql = (database: DatabaseAdapter) => sql({ database, deletedScope: 'active' });

export const readAuditEntry = (database: DatabaseAdapter, id: string) => firstSql<AuditEntryRow>(database, approvalSql(database).select({
	table: AUDIT_TABLE,
	columns: entryColumns,
	where: [{ column: 'id', value: id }],
}));

export type AuditRevertResult = { id: string; ok: boolean; message: string };

/**
 * 审批状态与数据状态是**两件事**，各占一列。
 *
 * 「没人批过」和「批过了」都让数据生效了，但不是同一个事实：前台自助与路由显式声明的
 * 机器写入根本没进过队列，记成「已批准」是在伪造一次不存在的审批。
 *
 * 两列正交还顺手解决了回滚的老问题：合成一列时，一条自助操作被回滚再恢复就会凭空变成
 * 「已批准」——恢复只能挑一个目标状态，而那个状态里混着审批信息。分开之后回滚与恢复
 * 只动 data_status，是谁放行的原样留着。
 */
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type DataStatus = 'unwritten' | 'applied' | 'reverted';
export type ApprovalTransition = 'approve' | 'reject' | 'withdraw' | 'revert' | 'redo' | 'requeue';

/**
 * 允许的迁移，其余一概拒绝。
 *
 * 「撤销申请」与「回滚」按对象区分，不靠词义：前者收回的是还没生效的申请（只动审批状态，
 * 数据从未动过），后者回滚的是已经生效的变更（只动数据状态，是谁放行的不变）。
 */
const TRANSITIONS: Record<ApprovalTransition, {
	label: string;
	/** 允许的起点。审批类动作看审批状态，数据类动作看数据状态。 */
	fromReview?: readonly ReviewStatus[];
	fromData?: readonly DataStatus[];
	/** 目标状态；不写这一列就不动它。 */
	review?: ReviewStatus;
	data?: DataStatus;
	/** 往表上写哪一侧的值：批准与恢复写 after，回滚写 before，驳回与撤销不碰数据。 */
	write: 'after' | 'before' | 'none';
}> = {
	approve: { label: '批准', fromReview: ['pending'], review: 'approved', data: 'applied', write: 'after' },
	reject: { label: '驳回', fromReview: ['pending'], review: 'rejected', write: 'none' },
	withdraw: { label: '撤销', fromReview: ['pending'], review: 'withdrawn', write: 'none' },
	revert: { label: '回滚', fromData: ['applied'], data: 'reverted', write: 'before' },
	/**
	 * **两个「往回走」在不同的轴上，因此名字要分开。**
	 *
	 * - 「重新应用」在**数据轴**：把回滚掉的变更再写回去（reverted → applied）。它**不是一次
	 *   决定**，只是把已经批准过的东西再写一遍，因此审批状态一动不动。
	 *
	 * 不叫「重做」：这一页上已经有「撤销」了，撤销/重做那一对会让人以为它俩相反，而它们
	 * 根本不在同一根轴上。也不叫「还原」——那个词留给回收站里把删掉的行捞回来。
	 *
	 * 「第一次生效」没有独立的名字，它就是**批准**的效果：批准同时推两根轴（审批 → 已批准，
	 * 数据 → 已生效），而重新应用只推数据那一根。
	 * - 「恢复」在**审批轴**：把被驳回或撤销的申请放回队列（rejected/withdrawn → pending），
	 *   让人再看一眼；数据一个字都不写回去，等批准了才写。
	 *
	 * 状态组合上互斥，一条记录同一时刻只可能用得上其中一个：被驳回的 data 是 unwritten，
	 * 满足不了重做的起点；回滚过的 review 是 approved，满足不了恢复的起点。但它们**可以先后
	 * 发生在同一条记录上**（驳回 → 恢复 → 批准 → 回滚 → 重做），所以时间/操作者各占一组列。
	 */
	redo: { label: '重新应用', fromData: ['reverted'], data: 'applied', write: 'after' },
	requeue: { label: '恢复', fromReview: ['rejected', 'withdrawn'], review: 'pending', write: 'none' },
};

export const transitionLabel = (transition: ApprovalTransition) => TRANSITIONS[transition].label;

/**
 * 状态迁移：撤销、恢复、批准、驳回是同一段代码。
 *
 * 一次变更**永远只有一条记录**：`changes` 里同时有前值和后值，`status` 说明当前停在哪一边。
 * 写哪一侧只看目标状态——落到 `applied` 就写 `after`、校验 `before`；落到 `reverted` 就反过来。
 * 批准（`pending → applied`）与恢复（`reverted → applied`）因此是同一条路径：两种情况下
 * 行上都还是 `before`，都要写成 `after`。驳回不碰数据，只落状态。
 */
/**
 * 这条记录指的是哪一行。
 *
 * 有 key 就用 key：`row_id` 是自增值，跨库搬迁后会指到别的行去；key 建后不改，
 * 正是为这种引用设计的。老记录没有 row_key，回落到 row_id。
 */
const rowCondition = (entry: AuditEntryRow): SqlCondition => (
	entry.row_key ? { column: 'key', value: entry.row_key } : { column: 'id', value: entry.row_id }
);

/**
 * 新建那一条走另一套写法。
 *
 * 它的 `changes` 里既有「要新增的内容」(给审批人看)，也有 `pended_at: 提交时刻 → 0`
 * (批准落到数据上就是这一列)。不能直接交给通用的写回路径：那条路径会拿每一列的前值
 * 当并发条件，而内容列的前值记的是 null，行上却早就是真实值——第一步就判成「已被后续
 * 修改覆盖」。所以这里只处理 `pended_at` 那一列。
 *
 * - **批准 / 恢复**：`pended_at` 归零，这一行开始对人可见。
 * - **驳回 / 撤销**：**软删除**，并把 `pended_at` 一并归零。
 * - **回滚**：同上——它已经生效过，按普通删除处理。
 *
 * 驳回原先是物理删除，理由是「它从未生效过，留着只是一份没人认领的草稿」。改成软删除
 * 的理由更强：软删除本来就有保留期，被驳回的新建因此在回收站里待着，看得见、找得回，
 * 而不是凭空消失——审批人手一抖驳回了别人半天的录入，那份录入不该就此不存在。
 *
 * `pended_at` 一起归零，是为了让它成为一条**普通的已删除记录**：留着非零的话，从回收站
 * 恢复出来的行仍然对业务查询不可见，却又出现在管理列表里(那里看得见待审批的行)，
 * 成了一个谁也说不清状态的幽灵。
 */
const applyInsertTransition = async (database: DatabaseAdapter, entry: AuditEntryRow, to: ApprovalTransition) => {
	const where = [rowCondition(entry)];
	const builder = sql({ database, subjectRoles: null });
	/**
	 * 「恢复」是把申请放回队列，因此那一行也要回到**待审批**的样子：从回收站捞出来，
	 * 并把 `pended_at` 写回提交时那个时刻——它就记在这条记录的 `changes` 里，
	 * 不用另猜一个时间戳，也就不会把「什么时候提交的」改掉。
	 */
	const pendedAt = to === 'requeue' ? Number(parseAuditChanges(entry.changes).pended_at?.before ?? 0) : 0;
	const statement = to === 'approve' ? builder.activate(entry.table_name, where)
		// 重新应用的对象是**被回滚过的**那一行，它当时是被软删除掉的，因此这里要动的是 deleted_at。
		: to === 'redo' ? builder.restore(entry.table_name, where)
			: to === 'requeue' ? builder.revert(entry.table_name, { deleted_at: 0, pended_at: pendedAt || Date.now() }, where)
				: builder.revert(entry.table_name, { deleted_at: Date.now(), pended_at: 0 }, where);
	const result = await runSystemSql(database, statement);
	return Number(result.meta?.changes ?? 0) > 0;
};

const transitionOne = async (database: DatabaseAdapter, entry: AuditEntryRow, to: ApprovalTransition, reason: string): Promise<AuditRevertResult> => {
	const allowed = TRANSITIONS[to];
	if (allowed.fromReview && !allowed.fromReview.includes(entry.review_status)) {
		return { id: entry.id, ok: false, message: `当前审批状态是「${REVIEW_LABELS[entry.review_status]}」，不能执行这个操作` };
	}
	if (allowed.fromData && !allowed.fromData.includes(entry.data_status)) {
		return { id: entry.id, ok: false, message: `当前数据状态是「${DATA_LABELS[entry.data_status]}」，不能执行这个操作` };
	}
	// 四组字段各写各的：同一条记录可能先被批准、再被回滚、又被恢复，合用一组的话后发生的
	// 会覆盖先发生的——恢复完之后「回滚人」就成了恢复的人。撤销也单独一组：它和审批都从
	// pending 出发，但一个是审批人的决定、一个是申请人自己收回。
	const now = Date.now(), actor = actorOf(database);
	const statusFields = to === 'withdraw' ? { withdrawn_at: now, withdrawn_duid: actor }
		: to === 'approve' || to === 'reject' ? { reviewed_at: now, reviewed_duid: actor, review_reason: reason }
			: to === 'revert' ? { reverted_at: now, reverted_duid: actor, revert_reason: reason }
				: to === 'requeue' ? { requeued_at: now, requeued_duid: actor, requeue_reason: reason }
					: { reapplied_at: now, reapplied_duid: actor, reapply_reason: reason };
	// 新建：行已经在库里，区别只在看不看得见（驳回与撤销则把它删掉）。
	if (entry.action === 'insert') {
		if (!await applyInsertTransition(database, entry, to)) {
			return { id: entry.id, ok: false, message: `原记录已不存在，无法${allowed.label}` };
		}
	}
	// 驳回与撤销申请都不碰数据：待审批的修改从未写入过。
	if (entry.action !== 'insert' && allowed.write !== 'none') {
		const changes = parseAuditChanges(entry.changes);
		const columns = Object.keys(changes);
		if (!columns.length) return { id: entry.id, ok: false, message: '该记录没有可还原的字段' };
		const toAfter = allowed.write === 'after';
		const write = (column: string) => toAfter ? changes[column].after : changes[column].before;
		const expect = (column: string) => toAfter ? changes[column].before : changes[column].after;
		// JSON 列记的是差异（只有变了的那几个键），写回时要合并进当前值——整块覆盖会把
		// 这条记录没提到的键一起抹掉。读一次当前行，合并出目标值，并用**读到的整值**
		// 作为并发条件：读—改—写之间被人插一手，条件就匹配不上，写入落空。
		const merged = new Map<string, { expect: unknown; write: unknown }>();
		const partial = columns.filter((column) => plainObject(expect(column)) || plainObject(write(column)));
		if (partial.length) {
			const current = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
				table: entry.table_name,
				columns: Object.fromEntries(partial.map((column) => [column, column])),
				where: [rowCondition(entry)],
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
				// 能让存储和后续 diff 都可读，也免得每次回滚都把整行的文本形态搅一遍。
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
			rowCondition(entry),
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
	await runSystemSql(database, sql({ database }).update(AUDIT_TABLE, {
		...(allowed.review ? { review_status: allowed.review } : {}),
		...(allowed.data ? { data_status: allowed.data } : {}),
		...statusFields,
	}, [
		{ column: 'id', value: entry.id },
		{ column: 'review_status', value: entry.review_status },
		{ column: 'data_status', value: entry.data_status },
	]));
	return { id: entry.id, ok: true, message: `已${allowed.label}` };
};

const actorOf = (database: DatabaseAdapter) => database.actorUidForTable?.(AUDIT_TABLE) ?? database.actorUid ?? null;

export const REVIEW_LABELS: Record<ReviewStatus, string> = { none: '无需审批', pending: '待审批', approved: '已批准', rejected: '已驳回', withdrawn: '已撤销' };
export const DATA_LABELS: Record<DataStatus, string> = { unwritten: '未写入', applied: '已生效', reverted: '已回滚' };

/**
 * 批量迁移是逐条执行的入口，**不是原子的级联回滚**——无事务环境下做不到。
 *
 * 执行顺序必须在实现里重排，不能沿用列表的显示顺序（§8）：同一列经历 A → B → C 后
 * 当前值是 C，只有先撤 B→C 才能接着撤 A→B。落到 applied 的方向正好相反，按时间升序走。
 * 某一条被拒绝时其余照常执行，最后逐条返回结果。
 */
/**
 * 把同一次操作的其余记录一并带上。
 *
 * 一次建号写三行（账号、凭证、资料），它们共享一个 `operation_id`。只批其中一条就是
 * 「账号能登录但没有密码」这种谁也没打算要的中间态——审批的对象是**一次操作**，
 * 不是一条记录。回滚与撤销同理：一次操作要么整个翻回去，要么原样留着。
 */
const withOperationSiblings = async (database: DatabaseAdapter, ids: readonly string[]) => {
	if (!ids.length) return [...ids];
	const selected = await allSql<{ id: string; operation_id: string; review_status: string }>(database, approvalSql(database).select({
		table: AUDIT_TABLE,
		columns: { id: { column: 'id', cast: 'text' }, operation_id: 'operation_id', review_status: 'review_status' },
	}));
	const chosen = selected.filter((entry) => ids.includes(String(entry.id)));
	const operations = new Set(chosen.map((entry) => entry.operation_id).filter(Boolean));
	const statuses = new Set(chosen.map((entry) => entry.review_status));
	// 只带上**同一状态**的兄弟：同一次操作里已经批过的那几条不该被再处理一遍。
	const siblings = selected.filter((entry) => operations.has(entry.operation_id) && statuses.has(entry.review_status));
	return [...new Set([...ids, ...siblings.map((entry) => String(entry.id))])];
};

export const transitionAuditEntries = async (database: DatabaseAdapter, requested: readonly string[], to: ApprovalTransition, reason = ''): Promise<AuditRevertResult[]> => {
	const ids = await withOperationSiblings(database, requested);
	const entries: AuditEntryRow[] = [];
	const results: AuditRevertResult[] = [];
	for (const id of ids) {
		const entry = await readAuditEntry(database, id);
		if (entry) entries.push(entry);
		else results.push({ id, ok: false, message: '审计记录不存在或无权访问' });
	}
	const newestFirst = (left: AuditEntryRow, right: AuditEntryRow) => Number(right.created_at) - Number(left.created_at) || Number(right.id) - Number(left.id);
	/**
	 * 「建起来」的动作从最早的一条开始，「拆掉」的从最新的一条往回走。
	 *
	 * 两个理由。一是值校验（§7.2）要求每一步的起点都是当前值，顺序反了整批失败。
	 * 二是同一次操作里的几行本来就有先后：建号先有账号，才谈得上它的密码和资料；
	 * 驳回与撤销对新建而言是物理删行，那是「拆」，必须反着来——先删账号再删它的凭证，
	 * 中间那一刻凭证指向的账号已经不存在了。库里眼下一个外键约束都没有，所以现在不报错，
	 * 但顺序错了就是错了。
	 */
	// 恢复是把申请装回队列，与批准同向：最旧的在前（先有账号才有凭证）。
	const dismantling = to === 'revert' || to === 'reject' || to === 'withdraw';
	entries.sort(dismantling ? newestFirst : (left, right) => newestFirst(right, left));
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
		const settings = normalizeSiteSettings(await createDatabaseConfigStore(withDatabaseActors(database, { subjectRoles: null }), tenant.id).get('site_settings'));
		removed += await purgeExpiredAuditEntries(database, settings.auditRetentionDays, { tenantId: tenant.id });
	}
	return removed;
};
