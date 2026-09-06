import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { createDatabaseConfigStore } from './config-store.mjs';
import { CONFIG_TABLE, invalidateConfigurationCache } from './configuration-cache.mjs';
import { readStoredPassword } from './auth/index.mjs';
import { normalizeSiteSettings } from './site-settings.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSql, runSystemSql, sql, type SqlAuditAction, type SqlCondition, type SqlSortOption } from '@server/database/sql.mjs';
import { isDigestValueColumn, isHiddenValueColumn, isHiddenValueKey } from '@shared/audit-tables.mjs';

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
	changes_before: string;
	changes_after: string;
	review_status: ReviewStatus;
	data_status: DataStatus;
	scope: 'admin' | 'self';
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
	changes_before: 'changes_before',
	changes_after: 'changes_after',
	review_status: 'review_status',
	data_status: 'data_status',
	scope: 'scope',
	created_at: 'created_at',
	created_duid: { column: 'created_duid', cast: 'text' as const },
	owner_uid: { column: 'owner_uid', cast: 'text' as const },
};

const parseValues = (value: unknown): Record<string, unknown> => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string' || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch { return {}; }
};

/**
 * 把分开存的前后两份值拼成 `{列名: {before, after}}`。
 *
 * **存储分开、内存里拼上**：读库的人要的是一份干净的值表，而比对、显示、写回这几段代码
 * 要的是成对的前后值——两边各取所需，转换只发生在这一处。
 */
export const parseAuditChanges = (entry: { changes_before?: unknown; changes_after?: unknown }): AuditChanges => {
	const before = parseValues(entry.changes_before);
	const after = parseValues(entry.changes_after);
	return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
		.map((column) => [column, { before: before[column], after: after[column] }]));
};

/** 写库时拆回两份。新建那一支的 before 是 `{}`：这一行之前不存在。 */
export const serializeAuditChanges = (changes: AuditChanges) => ({
	changes_before: JSON.stringify(Object.fromEntries(Object.entries(changes).filter(([, change]) => change.before !== undefined).map(([column, change]) => [column, change.before]))),
	changes_after: JSON.stringify(Object.fromEntries(Object.entries(changes).map(([column, change]) => [column, change.after]))),
});

/** 数组与对象按 JSON 显示：`String(['a','b'])` 得到 `a,b`，看不出它本来是个数组。 */
/**
 * 值读成人话。三种「没有值」要分清两件事：
 *
 * - `null` 是**人选的**（点 ✕ 存 NULL），念「未填写」。审批人读到的必须是他实际会批准的
 *   那一种，都念作「空」等于在最后一层把提交人刚做的选择抹掉。
 * - `undefined` 是**这份值里根本没提这一列**（新建记录的 `changes_before` 就是空对象），
 *   与空串一样什么也没说，念「空」。
 *
 * 空串也不能渲染成空白，否则摘要读起来是 `微信号： → 1`，一个断掉的箭头。前端确认框
 * （readableFieldValue）用同一套说法，两处必须读起来一样。
 */
const displayValue = (value: unknown) => value === null ? '未填写'
	: value === undefined || value === '' ? '空'
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
	/**
	 * 摘要列显示成**密码规律**：`空 → DDDDLLLL`（D 数字 / U 大写 / L 小写 / S 其他）。
	 *
	 * 「这个新账号的密码是 8 位纯数字」是一条审批人能据此驳回的理由，而规律本身既不是口令、
	 * 也推不出口令——它就是用户管理页上那一列「密码特征」。整块 blob 仍然不露：salt 与 hash
	 * 一个字都不显示。
	 */
	if (isDigestValueColumn(column)) {
		const pattern = (value: unknown) => readStoredPassword(value)?.pattern;
		const [before, after] = [pattern(change.before), pattern(change.after)];
		if (before !== undefined || after !== undefined) return [{ path: `${column}（规律）`, before, after, hidden: false }];
	}
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
 * `reasonKeyword` 走模糊匹配：操作原因是人写的自由文本，等值匹配没有意义。三态由
 * {@link SqlBuilder.search} 认——undefined 是不筛，空串是找没写理由的那些。
 */
/**
 * 符合条件的记录**总数**，与 listAuditEntries 用同一组条件。
 *
 * 列表有 200 条上限，拿它的长度当总数会在超过上限时谎报（库里 250 条却显示「共 200 条」）。
 * 计数单独查一次。
 */
export const countAuditEntries = async (database: DatabaseAdapter, where: SqlCondition[] = [], reasonKeyword?: string) => {
	const builder = sql({ database });
	const row = await firstSql<{ count: number }>(database, builder.count(AUDIT_TABLE, [...where, ...builder.search('reason', reasonKeyword, 'like')]));
	return Number(row?.count ?? 0);
};

export const listAuditEntries = async (database: DatabaseAdapter, where: SqlCondition[] = [], reasonKeyword?: string, limit = 200, sort?: SqlSortOption) => allSql<AuditEntryRow>(database, sql({ database }).select({
	table: AUDIT_TABLE,
	columns: entryColumns,
	sort,
	where: [...where, ...sql({ database }).search('reason', reasonKeyword, 'like')],
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
const auditSql = (database: DatabaseAdapter) => sql({ database, deletedScope: 'active' });

export const readAuditEntry = (database: DatabaseAdapter, id: string) => firstSql<AuditEntryRow>(database, auditSql(database).select({
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
export type AuditTransition = 'approve' | 'reject' | 'withdraw' | 'revert' | 'redo' | 'requeue';

export const AUDIT_TRANSITION_TABLE = 'base_audit_transitions';

/** 一条审批记录上发生过的一次迁移。谁与什么时候由公共层的 created_duid / created_at 填。 */
export type AuditTransitionRow = { id: string; audit_id: string; kind: AuditTransition; reason: string; created_at: number; created_duid: string | null };

const eventColumns = {
	id: { column: 'id', cast: 'text' as const },
	audit_id: { column: 'audit_id', cast: 'text' as const },
	kind: 'kind',
	reason: 'reason',
	created_at: 'created_at',
	created_duid: { column: 'created_duid', cast: 'text' as const },
};

/**
 * 这一批记录上发生过的迁移，按记录分组、每组按发生顺序。
 *
 * 一次 IN 查询取回来再在内存里分组：列表本来就有 200 条上限，为此给 SQL 层加一个
 * 「按记录取最后一条」的形状不划算——那是相关子查询或窗口函数，四种方言各写一遍。
 */
export const auditTransitionsFor = async (database: DatabaseAdapter, auditIds: readonly string[]) => {
	const grouped = new Map<string, AuditTransitionRow[]>();
	if (!auditIds.length) return grouped;
	const wanted = new Set(auditIds.map((id) => String(id)));
	const rows = await allSql<AuditTransitionRow>(database, sql({ database, deletedScope: 'active' }).select({
		table: AUDIT_TRANSITION_TABLE, columns: eventColumns, orderBy: [{ column: 'id' }],
	}));
	for (const row of rows) {
		const id = String(row.audit_id);
		if (!wanted.has(id)) continue;
		grouped.set(id, [...(grouped.get(id) ?? []), row]);
	}
	return grouped;
};

/**
 * 允许的迁移，其余一概拒绝。
 *
 * 「撤销申请」与「回滚」按对象区分，不靠词义：前者收回的是还没生效的申请（只动审批状态，
 * 数据从未动过），后者回滚的是已经生效的变更（只动数据状态，是谁放行的不变）。
 */
const TRANSITIONS: Record<AuditTransition, {
	label: string;
	/** 允许的起点。审批类动作看审批状态，数据类动作看数据状态。 */
	fromReview?: readonly ReviewStatus[];
	fromData?: readonly DataStatus[];
	/** 目标状态；不写这一列就不动它。 */
	review?: ReviewStatus;
	data?: DataStatus;
	/** 往表上写哪一侧的值：批准与重新应用写 after，回滚写 before，驳回与撤销不碰数据。 */
	write: 'after' | 'before' | 'none';
	/**
	 * 只对新建开放。
	 *
	 * 被否掉的**修改/删除/还原**不给「恢复」：重新提交一次就是了，两条路做同一件事，
	 * 而多一条路就多一处状态要想。**新建不一样**——重来要把整张表单再填一遍，而那一行
	 * 还带着内容躺在回收站里，捞回来比重填便宜得多；何况建号写三行，从回收站一张表一张表
	 * 地捞会漏掉凭证，账号看着正常却登不进去。
	 */
	insertOnly?: true;
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
	requeue: { label: '恢复', fromReview: ['rejected', 'withdrawn'], review: 'pending', write: 'none', insertOnly: true },
};

export const transitionLabel = (transition: AuditTransition) => TRANSITIONS[transition].label;

/**
 * `批准(approve)`：中文取自 {@link TRANSITIONS} 的动作名，括号里是这一列的原文。
 *
 * **一个 kind 只有一个中文名。** 原先这里另有一套说法（`管理批准`、`执行回滚`、`撤销申请`），
 * 按「谁做的、动的是什么」加了前缀——读起来是舒服，可同一个 `redo` 在按钮上叫「重新应用」、
 * 在记录里叫「执行重做」，两个词指同一件事，那正是命名歧义本身。谁做的由旁边的操作者列
 * 回答，不必编进类型名里。
 *
 * 带上英文键：这一列的值本来就是 `approve`、`revert` 这些原文，查库、看日志、翻文档时
 * 对得上号，不必在脑子里做一次翻译。
 */
export const kindLabel = (kind: AuditTransition) => `${TRANSITIONS[kind].label}(${kind})`;

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
 * 它的 `changes` 里既有「要新增的内容」(给审批人看)，也有 `queued_at: 提交时刻 → 0`
 * (批准落到数据上就是这一列)。不能直接交给通用的写回路径：那条路径会拿每一列的前值
 * 当并发条件，而内容列的前值记的是 null，行上却早就是真实值——第一步就判成「已被后续
 * 修改覆盖」。所以这里只处理 `queued_at` 那一列。
 *
 * - **批准 / 恢复**：`queued_at` 归零，这一行开始对人可见。
 * - **驳回 / 撤销**：**软删除**，并把 `queued_at` 一并归零。
 * - **回滚**：同上——它已经生效过，按普通删除处理。
 *
 * 驳回原先是物理删除，理由是「它从未生效过，留着只是一份没人认领的草稿」。改成软删除
 * 的理由更强：软删除本来就有保留期，被驳回的新建因此在回收站里待着，看得见、找得回，
 * 而不是凭空消失——审批人手一抖驳回了别人半天的录入，那份录入不该就此不存在。
 *
 * `queued_at` 一起归零，是为了让它成为一条**普通的已删除记录**：留着非零的话，从回收站
 * 恢复出来的行仍然对业务查询不可见，却又出现在管理列表里(那里看得见待审批的行)，
 * 成了一个谁也说不清状态的幽灵。
 */
/** 递归按键名排序：比较 JSON 值时键序不能算差异。 */
const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== 'object') return value;
	const source = value as Record<string, unknown>;
	return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalValue(source[key])]));
};

/**
 * 比较用的归一形式。三种情况都要拉平，否则「内容没变」会被判成「被人改过」：
 *
 * - **BIGINT** 各驱动返回的类型不一（number / string / bigint），一律按字符串比。
 * - **数组与对象**按 JSON 比：`String(['a','b'])` 得到 `a,b`，两个不同的数组会撞上。
 * - **键序**必须先排。行上读回来的是文本，而 JSON 列在 PostgreSQL 上落成 **JSONB**——
 *   它按自己的规则重排键，回读到的字符串与写进去时的不是同一串。不排的话，凡是带 JSON
 *   列的新建（`password` 就是一个）在 PostgreSQL 上每次批准都会被判成「内容与申请不一致」，
 *   而在 SQLite 上一切正常，只有上线才发作。
 */
const storedKey = (value: unknown) => {
	if (value === null || value === undefined) return '';
	// 文本先试着当 JSON 解一次：行上的 JSON 列读回来是字符串，记录里存的是对象。
	// 只认对象与数组——`'123'` 解出来是数字，那是普通业务文本，不能当 JSON 处理。
	const parsed = typeof value === 'string'
		? (() => { try { const result: unknown = JSON.parse(value); return result && typeof result === 'object' ? result : value; } catch { return value; } })()
		: value;
	return typeof parsed === 'object' ? JSON.stringify(canonicalValue(parsed)) : String(parsed);
};

/**
 * 让这一行生效之前核一遍：它的内容还是不是申请里写的那一份。
 *
 * **批准修改早就有这道校验**（每一列的当前值必须还等于记录里的前值），批准新增却没有——
 * `activate()` 只把 `queued_at` 归零，不看内容。于是待审批期间那一行被别处改过的话，
 * 审批人看着「newguy / 普通用户」点了批准，生效的却是「hijacked / 平台管理员」，
 * 而记录上仍然写着他看过的那一份。**你批的必须就是你看到的。**
 *
 * 只核记录里写下的那几列：归属、时间戳、`queued_at` 这些本来就不进 changes（见
 * insertChanges），它们在待审批期间被公共层动过是正常的——`queued_at` 更是这一步要改的
 * 那一列，核它等于自己跟自己过不去。
 */
const insertContentMatches = async (database: DatabaseAdapter, entry: AuditEntryRow) => {
	const expected = Object.entries(parseAuditChanges(entry)).map(([column, change]) => [column, change.after] as const);
	if (!expected.length) return true;
	const builder = sql({ database, subjectRoles: null });
	// 一律 cast 成文本：BIGINT 是雪花号，按数字读会溢出；归一之后两边才比得起来。
	const row = await firstSql<Record<string, unknown>>(database, builder.select({
		table: entry.table_name,
		columns: Object.fromEntries(expected.map(([column]) => [column, { column, cast: 'text' as const }])),
		where: [rowCondition(entry)], deleted: 'all', queued: 'all', limit: 1,
	}));
	if (!row) return false;
	return expected.every(([column, value]) => storedKey(row[column]) === storedKey(value));
};

const applyInsertTransition = async (database: DatabaseAdapter, entry: AuditEntryRow, to: AuditTransition) => {
	const where = [rowCondition(entry)];
	const builder = sql({ database, subjectRoles: null });
	/**
	 * 「恢复」是把申请放回队列，因此那一行也要回到**待审批**的样子：从回收站捞出来，
	 * `queued_at` 重新写上**此刻**——它是「什么时候进的队列」，而这条申请正是现在才回到
	 * 队列里的。当初提交的时刻另有去处，记在这条记录的 `created_at` 上。
	 */
	const statement = to === 'approve' ? builder.activate(entry.table_name, where)
		// 重新应用的对象是**被回滚过的**那一行，它当时是被软删除掉的，因此这里要动的是 deleted_at。
		: to === 'redo' ? builder.restore(entry.table_name, where)
			: to === 'requeue' ? builder.revert(entry.table_name, { deleted_at: 0, queued_at: Date.now() }, where)
				: builder.revert(entry.table_name, { deleted_at: Date.now(), queued_at: 0 }, where);
	const result = await runSystemSql(database, statement);
	return Number(result.meta?.changes ?? 0) > 0;
};

const transitionOne = async (database: DatabaseAdapter, entry: AuditEntryRow, to: AuditTransition, reason: string): Promise<AuditRevertResult> => {
	const allowed = TRANSITIONS[to];
	if (allowed.fromReview && !allowed.fromReview.includes(entry.review_status)) {
		return { id: entry.id, ok: false, message: `当前审批状态是「${REVIEW_LABELS[entry.review_status]}」，不能执行这个操作` };
	}
	if (allowed.fromData && !allowed.fromData.includes(entry.data_status)) {
		return { id: entry.id, ok: false, message: `当前数据状态是「${DATA_LABELS[entry.data_status]}」，不能执行这个操作` };
	}
	if (allowed.insertOnly && entry.action !== 'insert') {
		return { id: entry.id, ok: false, message: '只有被否掉的新增可以恢复，其余重新提交一次就是了' };
	}
	/**
	 * **放回队列之前先看那一行的队列有没有空位。**
	 *
	 * `settled_at` 归零会让这条记录重新占住 `(table_name, row_key, 0)` 那个位置，而那上面有
	 * 唯一索引（一行同时只能有一条在队列里）。位置被占着时归零撞索引，抛出来的是裸的
	 * `UNIQUE constraint failed`，接口回 500。
	 *
	 * 这条路完全可达：新建被驳回 → 那一行进回收站 → 有人从回收站还原（排进一条 restore）
	 * → 再来恢复那条被驳回的新建。**先查再给人话**，别让人对着 500 猜。
	 */
	if (allowed.review === 'pending') {
		const occupying = await firstSql<{ id: string }>(database, auditSql(database).select({
			table: AUDIT_TABLE, columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'table_name', value: entry.table_name }, { column: 'row_key', value: entry.row_key }, { column: 'settled_at', value: 0 }],
			limit: 1,
		}));
		if (occupying && String(occupying.id) !== String(entry.id)) {
			return { id: entry.id, ok: false, message: `这一行已经有另一条申请（#${occupying.id}）在队列里，一行同时只能有一条——请先把那一条处理掉` };
		}
	}
	// 新建：行已经在库里，区别只在看不看得见（驳回与撤销则把它删掉）。
	if (entry.action === 'insert') {
		/**
		 * **这一行还要继续存在的每一次翻面，都要求它的内容还是记录上那一份。**
		 *
		 * 批准、回滚、重新应用三步都是审批人照着这条记录的 `changes_after` 点的头，
		 * 三步过后那一行都还在库里（生效、进回收站、再生效），带着的就是这份内容。原先
		 * 只核了批准，于是：回滚过的行在回收站里被改一笔（那一行照样收得下修改申请），
		 * 再点「重新应用」，记录上写着 enabled、捞回主表的却是 disabled；回滚同理，
		 * 看着 A 下线的却是 B，而别人对这一行的合法修改就这么被一起埋了。
		 *
		 * **驳回与撤销不核，这是有意留的退路。** 它们把这一行彻底作废——申请结束、行删掉，
		 * 不留下任何还要继续用的东西。这里也跟着核的话，一条内容被动过手脚的待审批新增
		 * 就成了死结：批不了（内容不符），也否不掉（同样内容不符），队列里卡着一条谁也
		 * 收不了场的申请。作废一份被动过手脚的东西，不该被那手脚挡住。
		 *
		 * 恢复（requeue）把行放回队列，它在队列里仍然不可见，后面还要再走一次批准，
		 * 那一次会核，这里不必重复。
		 */
		if ((to === 'approve' || to === 'redo' || to === 'revert') && !await insertContentMatches(database, entry)) {
			return { id: entry.id, ok: false, message: `这一行的内容与申请里的不一致，无法${allowed.label}——它在这之后被改过，请刷新后重新确认` };
		}
		if (!await applyInsertTransition(database, entry, to)) {
			return { id: entry.id, ok: false, message: `原记录已不存在，无法${allowed.label}` };
		}
	}
	// 驳回与撤销申请都不碰数据：待审批的修改从未写入过。
	if (entry.action !== 'insert' && allowed.write !== 'none') {
		/**
		 * **改与删只作用在已经生效的那一行上：`queued_at` 必须是 0。**
		 *
		 * 把一份变更盖在还没生效、外面根本看不见的行上是说不通的：它将来一旦被批准，
		 * 放出去的内容已经不是那条新增记录上写的那一份了；回滚同理——把旧值写回一个
		 * 还没生效的行，等于替一件还没发生的事做撤销。
		 *
		 * 这是一道**前置条件，不是在补一个正在漏的洞**：眼下走不到这里，因为改一份还没
		 * 生效的新建根本不会另开申请，而是直接写进去、顺手刷新那条新增记录的
		 * `changes_after`（§13.6 的例外，test:change-audit 守着）。于是「有一条修改申请，
		 * 它指着的行却还在队列里」这个组合造不出来。写在这儿是因为这一段的每一行 SQL
		 * 都默认了「目标行已经生效」，而那件事此前只由别处的一条例外顺带保证着——
		 * 那条例外将来动一动，这里就会安静地把变更写进一个还不存在的东西里。
		 *
		 * 查一次而不是塞进 WHERE：塞进去写入落空只会报「已被后续修改覆盖」，那不是实情，
		 * 照着那句话去刷新页面也看不出任何被改过的痕迹。
		 */
		const state = await firstSql<{ queued_at: unknown }>(database, sql({ database }).select({
			table: entry.table_name,
			columns: { queued_at: { column: 'queued_at', cast: 'text' } },
			where: [rowCondition(entry)], deleted: 'all', queued: 'all', limit: 1,
		}));
		if (!state) return { id: entry.id, ok: false, message: `原记录已不存在，无法${allowed.label}` };
		if (String(state.queued_at ?? '0') !== '0') {
			return { id: entry.id, ok: false, message: `这一行还在审批队列里等着生效，无法${allowed.label}——请先处理建它的那条新增申请` };
		}
		const changes = parseAuditChanges(entry);
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
	}
	/**
	 * 审批通过是直接把值写回表的，绕过了 configStore 那条会清缓存的路；不清的话批准完
	 * 页面还显示旧值，看起来像批准没生效。
	 *
	 * **新建那一支同样要清。** 原先这一句只在修改那一支里，而种子只预建了三条站点配置
	 * （site_frontend / site_backend / admin_settings）——`tech_stack` 与
	 * `accounts_oidc_client` 的第一次保存走的是 INSERT，于是「批准了但 30 秒内不生效」：
	 * 库里已经是新值，接口读到的还是旧的，等缓存自然过期才对上。改后缀那一页最容易撞到，
	 * 因为它改的正是接口地址本身。
	 *
	 * 不区分是哪一种迁移：走到这里就说明这一行动过了，而配置变更本就罕见，多清一次
	 * 只是让各租户各自重读一遍。
	 */
	if (entry.table_name === CONFIG_TABLE) invalidateConfigurationCache();
	/**
	 * **先追加事件，再更新那两个状态列。**
	 *
	 * 两个状态列是**缓存**：真相是事件序列。这个顺序在无事务环境下更安全——断在中间的
	 * 表现是「事件在、状态没跟上」，读的时候以事件为准就能自愈；反过来则是「状态改了
	 * 但没人知道是谁改的」，那才查不出来。
	 *
	 * 谁和什么时候不用写：`created_duid` / `created_at` 是每张表都有的系统列，公共层填。
	 * 走 runSystemSql：这条事件本身就是这次迁移的留痕，再为它记一条审批记录是套娃。
	 */
	await runSystemSql(database, sql({ database }).insert(AUDIT_TRANSITION_TABLE, { audit_id: entry.id, kind: to, reason }));
	/**
	 * 带上原状态做条件：并发下只有一个请求能迁移成功。
	 *
	 * `settled_at` 跟着审批状态走，不跟数据状态走：批准、驳回、撤销都是**了结**，
	 * 恢复（requeue）把它放回队列因此归零；回滚与重新应用只改数据状态，这条申请早就了结了，
	 * 归零会让它重新占住队列里那个位置，把别人挡在门外（见 base_audits.settled_at）。
	 */
	const settled = allowed.review === undefined ? {}
		: { settled_at: allowed.review === 'pending' ? 0 : Date.now() };
	const moved = await runSystemSql(database, sql({ database }).update(AUDIT_TABLE, {
		...(allowed.review ? { review_status: allowed.review } : {}),
		...(allowed.data ? { data_status: allowed.data } : {}),
		...settled,
	}, [
		{ column: 'id', value: entry.id },
		{ column: 'review_status', value: entry.review_status },
		{ column: 'data_status', value: entry.data_status },
	]));
	/**
	 * **条件更新的结果要看。** 带上原状态做条件本来就是为了并发下只有一个请求能迁移成功，
	 * 可原先没人检查它改没改到行——两个请求同时进来时，两个都回「已批准」「已驳回」，
	 * 而实际只发生了一次。第二个人以为自己做成了。
	 *
	 * 单进程 SQLite 撞不上（读写是串行的，后一个请求在前置检查那里就被挡住了），多实例
	 * 部署会。已知限制见需求文档 §14：数据写入排在这一步之前，因此并发下仍可能出现
	 * 「数据按 A 的意思写了、状态却是 B 的」，那要靠把抢占提到写入之前才能根治。
	 */
	if (Number(moved.meta?.changes ?? 0) === 0) {
		return { id: entry.id, ok: false, message: '这条申请刚被别人处理过，请刷新后再看' };
	}
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
	const selected = await allSql<{ id: string; operation_id: string; review_status: string }>(database, auditSql(database).select({
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

export const transitionAuditEntries = async (database: DatabaseAdapter, requested: readonly string[], to: AuditTransition, reason = ''): Promise<AuditRevertResult[]> => {
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
	/**
	 * **只清已经了结的，而且从「了结」那一刻起算。**
	 *
	 * 原先的条件只有 `created_at < cutoff`，不看这条申请处理完了没有。于是一条卡在队列里
	 * 超过保留期的**新建**申请会被物理删掉，而它那一行还带着 `queued_at != 0` 躺在库里：
	 * 谁也看不见它（正常查询过滤掉了），谁也批不了它（申请没了），它也不在回收站
	 * （`deleted_at` 是 0）——连带把那个用户名永久占住，因为唯一索引里它还活着。
	 * 只要有申请卡过保留期，这个幽灵行就必然出现。
	 *
	 * 起点也从 `created_at` 换成 `settled_at`：保留期说的是「**处理完的**记录留多久」。
	 * 按提交时刻算的话，一条提交一年后才批准的申请，批准当天就到期该清了——它的留痕
	 * 一天都没留住。
	 */
	const scope: SqlCondition[] = [
		{ column: 'settled_at', operator: '>', value: 0 },
		{ column: 'settled_at', operator: '<', value: cutoff },
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
			// 事件先删：留下指向不存在记录的事件，比留下一条没有经过的记录更难解释。
			await runSql(database, sql({ database, subjectRoles: null }).delete(AUDIT_TRANSITION_TABLE, [{ column: 'audit_id', value: row.id }]));
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
