import type { DatabaseAdapter, DatabaseActorResolver, DatabaseActorUid, DatabaseRunResult } from './index.mjs';
import { isSystemField, SYSTEM_FIELD_NAMES } from '@shared/system-fields.mjs';
import { nextSnowflake } from '@server/modules/base/snowflake.mjs';

export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql';
export type SqlActorContext = DatabaseActorUid | DatabaseActorResolver;
export type SqlContext = { database: DatabaseAdapter; actorUid?: DatabaseActorUid; actorUidForTable?: DatabaseActorResolver; ownerUid?: DatabaseActorUid; ownerUidForTable?: DatabaseActorResolver; ownerTid?: DatabaseActorUid; ownerTidForTable?: DatabaseActorResolver; ownerBid?: DatabaseActorUid; ownerBidForTable?: DatabaseActorResolver; subjectRoles?: readonly string[] | null; deletedScope?: DeletedScope; pendedScope?: PendedScope };
/**
 * update 附带的变更留痕元信息，由 runSql 消费：读原行、比对、记录，然后才执行。
 * SqlBuilder 保持纯函数，多步副作用放不进去（见需求文档 §6.1）。业务代码不构造也不读取它。
 */
export type SqlAuditOwnership = { tid?: DatabaseActorUid; bid?: DatabaseActorUid; uid: DatabaseActorUid | null; actor: DatabaseActorUid | null };
export type SqlAuditMetadata = { table: string; values: Values; where: SqlCondition[]; owner: SqlAuditOwnership };
export type SqlQuery = { query: string; values: unknown[]; audit?: SqlAuditMetadata; insertAudit?: SqlInsertAuditMetadata };

/**
 * 新建一行时附上的信息，供操作层记一条 `action=insert`。
 *
 * 与 update 的 {@link SqlAuditMetadata} 分开放，是因为**它不触发 runSql 的守卫**：
 * 会话、登录挑战、设备注册、验证码这些机器写入也走 insert，把它们一并拦下来要么让
 * 系统跑不动，要么把审批表冲爆。是不是人做的操作由调用方选 runOperationSql 还是 runSql
 * 来声明——这与 update 那边「runOperation 显式声明」是同一条线。
 */
export type SqlInsertAuditMetadata = {
	table: string;
	rowKey: string;
	/** 这条 INSERT 最终写入的全部列值（含系统字段）。待审批时照原样重建一条带 pended_at 的。 */
	values: Values;
	owner: SqlAuditOwnership;
};
type SqlValue = unknown;
type Values = Record<string, SqlValue | undefined>;
type InsertSelectValue = SqlValue | { column: string };
export type DeletedScope = 'active' | 'deleted' | 'all';
/**
 * 待审批的新行看不看得见。
 *
 * 与 DeletedScope 分开，因为它们回答的是两个问题:「这一行删了没有」和「这一行批了没有」。
 * 合成一个枚举的话，想看待审批的行就得顺带把回收站也打开。
 */
export type PendedScope = 'active' | 'all';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const quoteIdentifier = (identifier: string, dialect: SqlDialect) => {
	const parts = identifier.split('.');
	if (!parts.every((part) => identifierPattern.test(part))) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return parts.map((part) => dialect === 'mysql' ? `\`${part}\`` : `"${part}"`).join('.');
};

const dialectOf = (database: DatabaseAdapter): SqlDialect => database.dialect ?? 'sqlite';
const definedEntries = (values: Values) => Object.entries(values).filter((entry): entry is [string, SqlValue] => entry[1] !== undefined);
/**
 * ON CONFLICT 的目标列。**必须与库里那条唯一索引逐列对上**，对不上 PostgreSQL 会直接报
 * 「no unique or exclusion constraint matching the ON CONFLICT specification」。
 *
 * **只有 `name` 参与的唯一索引带 `deleted_at`。** 名字是人取的，删掉一行之后同一个名字
 * 该能再用——`deleted_at` 进索引正是为了这件事（软删的行带着非 0 的时间戳，与新行不撞）。
 *
 * 其余一律不带。它们要么是系统生成、永不重复的标识（雪花号 `key`、各种 hash、token、
 * 自增 id），`deleted_at` 在那里纯属多余；要么是外部给的稳定标识（provider、subject、
 * telegram_user_id），删了再回来还是同一个东西，本来就不该换一行。
 *
 * 代价说在前面：这些值**软删之后不能重建同一个**。删掉一条 `hostname` 绑定再绑同一个
 * 域名、删掉一个套餐规格再建同样的 cpu/内存组合，都会撞上那条已删除的行。
 */
const conflictTarget = (keys: string[]) => {
	if (!keys.length) throw new Error('INSERT conflict keys cannot be empty');
	if (keys.includes('deleted_at')) return keys;
	return keys.includes('name') ? [...keys, 'deleted_at'] : keys;
};
const assertBusinessWriteFields = (values: Values, options: { allowId?: boolean; allowKey?: boolean; allowManagedFlags?: boolean } = {}) => {
	const protectedFields = Object.keys(values).filter((field) => isSystemField(field)
		&& !(options.allowId && field === 'id')
		&& !(options.allowKey && field === 'key')
		// deleted_at 与 pended_at 都由专用方法写（softDelete / restore / revert / activate），
		// 业务代码一律不许直接传。
		&& !(options.allowManagedFlags && (field === 'deleted_at' || field === 'pended_at')));
	if (protectedFields.length) throw new Error(`系统字段由 SQL 公共层维护，业务代码不得传入：${protectedFields.join('、')}（固定字段：${SYSTEM_FIELD_NAMES.join('、')}）`);
};

/**
 * `raw` 变体只供公共层内部构造（行级判定的常量条件），不对业务代码开放：
 * 它绕过 quoteIdentifier 的标识符校验，业务传入等于开了一个拼 SQL 的口子。
 */
export type SqlCondition =
	// LIKE 的通配符与转义字符由调用方自己拼进 value，这里不做加工——
	// 加工就得替调用方猜「%」是想匹配任意串还是想匹配一个百分号。
	| { column: string; value?: SqlValue; operator?: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL'; raw?: undefined }
	| { raw: string; column?: undefined; value?: undefined; operator?: undefined };

/** 该条件是否需要绑定一个参数值。raw 与 IS NULL 系列都不绑定。 */
/**
 * 变更审批表与它自己的动作常量。这张表自身不被审计，否则记录一条变更会再产生一条变更。
 *
 * 表名叫 base_approvals 而不是 base_audit_entries：这里存的不是"谁看了什么"的审计流水，
 * 而是每一次后台修改的申请与它的去向——待审批、已生效、已驳回、已撤销、已回滚。
 */
/**
 * 没有 key 列的表。
 *
 * 只有发号器自己的状态表：发一个 key 要先读它，给它也加上 key 就成了死循环。
 * 由 test:naming 守着——别的表漏了 key 列会在这里被挡下。
 */
export const KEYLESS_TABLES = new Set([
	// 发号器自己的状态表：发 key 要先读它。
	'global_snowflake_state',
	// 迁移记录表：它在**建库之前**就要写入，那时发号器还没有号段可用（号段存在
	// global_snowflake_state 里，而那张表正是迁移建出来的）。它也不是业务数据。
	'global_schema_migrations',
]);

/**
 * `key` 允许的字符。
 *
 * VARCHAR(36) 只管长度不管字符集，而 CHECK 约束 Prisma schema 写不出来（手写就破坏了
 * 「迁移全部由 prisma 生成」）。因此校验放在唯一的写入口上：所有 key 都要经过这里，
 * 无论是人给的短串、客户端的设备 UUID，还是发号器发的雪花。
 */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;
export const assertRowKey = (table: string, value: unknown) => {
	if (typeof value === 'string' && KEY_PATTERN.test(value)) return;
	throw new Error(`${table}.key 只能是英文字母、数字、下划线和连字符，最长 36 位：${String(value)}`);
};

export const AUDIT_TABLE = 'base_approvals';
/**
 * 列表查询的排序。
 *
 * `request` 是请求里要求的排序，`expose` 由查询回调给上层，告诉它**这条查询选出了哪些列**
 * ——能排序的恰好就是这些，因此不需要另维护一份白名单，也不会随着列的增减走偏。
 * 请求里出现的字段名只是查这张表的键，拼不进 SQL。
 */
export type SqlSortOption = {
	/** 多列排序，靠前的优先。 */
	request?: ReadonlyArray<{ field: string; direction: 'ASC' | 'DESC' }>;
	expose?: (fields: string[]) => void;
};

/** 与 Prisma schema 里 owner_tid / owner_bid 的 @default(1) 对应：不写这两列时数据库落到默认租户与主分站。 */
const DEFAULT_OWNER_ID = 1;
export type SqlAuditAction = 'insert' | 'update' | 'soft_delete' | 'restore' | 'purge';
export type SqlAuditChange = { before: SqlValue; after: SqlValue };
export type SqlAuditChanges = Record<string, SqlAuditChange>;

/**
 * 附在受管写入上的结构化信息，供操作层读原行、算差异。
 *
 * 这里**不判断这次写入算不算人工操作**——那个信息在路由层才完整，SqlBuilder 看到的
 * 只是一条 SQL 片段。判定由 runOperation 显式声明，runSql 只负责在漏包时报错。
 */
const auditMetadata = (table: string, values: Values, where: SqlCondition[], owner: SqlAuditOwnership): { audit?: SqlAuditMetadata } => {
	const audited = definedEntries(values);
	if (!audited.length) return {};
	// where 是**完整**条件（含可见性判定），归属也在这里定死：调用方可能用显式上下文
	// 覆盖适配器（系统写入就是这么做的），事后从适配器重新推导会得到另一套判定。
	return { audit: { table, values: Object.fromEntries(audited), where, owner } };
};

const bindsValue = (condition: SqlCondition) => condition.raw === undefined && !['IS NULL', 'IS NOT NULL'].includes(condition.operator ?? '');
const renderCondition = (condition: SqlCondition, dialect: SqlDialect, nextPlaceholder: () => string) => {
	if (condition.raw !== undefined) return condition.raw;
	const operator = condition.operator ?? '=';
	return ['IS NULL', 'IS NOT NULL'].includes(operator)
		? `${quoteIdentifier(condition.column, dialect)} ${operator}`
		: `${quoteIdentifier(condition.column, dialect)} ${operator} ${nextPlaceholder()}`;
};
export type SqlJoin = { type?: 'INNER' | 'LEFT'; table: string; alias?: string; left: string; right: string };
export type SqlColumn = string | { column: string; cast?: 'text' };
/** Normal queries see active rows; recycle-bin code must explicitly request deleted/all rows. */
export type SqlSelectOptions = { table: string; alias?: string; distinct?: boolean; columns?: Record<string, SqlColumn>; sort?: SqlSortOption; includeAll?: boolean; sqliteRowIdAlias?: string; joins?: SqlJoin[]; where?: SqlCondition[]; orderBy?: Array<{ column: string; direction?: 'ASC' | 'DESC' }>; limit?: number; offset?: number; deleted?: DeletedScope; pended?: PendedScope };

export abstract class SqlBuilder {
	constructor(readonly dialect: SqlDialect, readonly actorContext: SqlActorContext = null, readonly defaultDeletedScope: DeletedScope = 'active', readonly ownerContext: SqlActorContext = null, readonly tenantContext: SqlActorContext = null, readonly branchContext: SqlActorContext = null, readonly subjectRoles: readonly string[] | null = null, readonly defaultPendedScope: PendedScope = 'active') {}

	/**
	 * 行级可见性判定。返回要追加到 WHERE 的条件，空数组表示不限制。
	 *
	 * subjectRoles 为 null 表示**系统上下文**（未绑定主体）：迁移、种子、鉴权自身、
	 * 清理任务都走这条路，完全跳过判定。绑定了主体才受限，哪怕角色数组是空的。
	 *
	 * 四种情况都是单个索引等值，没有 OR、子查询或 JOIN。
	 */
	protected visibilityConditions(table: string, alias?: string): SqlCondition[] {
		const roles = this.subjectRoles;
		if (roles === null) return [];
		// Passport 是跨站点跨租户的统一身份中心，它的数据不属于任何租户、分站或本站账号，
		// 而且大多在匿名流程（登录、绑定、OIDC 协议）中创建，owner_uid 本就为空。
		// 它的访问控制在协议层与查询层：会话令牌、客户端认证，以及查询里显式的 user_id 过滤。
		// 后台管理由路由层角色门限制。行级归属判定对它既不适用也会把正常流程挡死。
		if (table.startsWith('passport_')) return [];
		if (roles.includes('platform_admin')) return [];
		const prefix = alias ?? table;
		if (roles.includes('tenant_admin')) {
			const tenantId = this.ownerTidFor(table);
			return tenantId === undefined ? [{ raw: '1 = 0' }] : [{ column: `${prefix}.owner_tid`, value: tenantId }];
		}
		if (roles.includes('branch_admin')) {
			const branchId = this.ownerBidFor(table);
			return branchId === undefined ? [{ raw: '1 = 0' }] : [{ column: `${prefix}.owner_bid`, value: branchId }];
		}
		const actingUid = this.ownerUidFor(table);
		// 已绑定主体但没有账号（例如只有 Accounts 身份的访客）：什么都看不到。
		// 显式写成 1 = 0 而不是依赖 owner_uid = NULL 求值为 unknown——后者是巧合不是语义。
		return actingUid === null ? [{ raw: '1 = 0' }] : [{ column: `${prefix}.owner_uid`, value: actingUid }];
	}
	protected actorUidFor(table: string): DatabaseActorUid | null {
		const value = typeof this.actorContext === 'function' ? this.actorContext(table) : this.actorContext;
		return value ?? null;
	}
	protected ownerUidFor(table: string): DatabaseActorUid | null {
		// Ownership follows the current request user, just like the device-user
		// audit actor. It never falls back to a row's user_id: system flows and
		// unauthenticated creation must remain NULL.
		const value = typeof this.ownerContext === 'function' ? this.ownerContext(table) : this.ownerContext;
		return value ?? null;
	}
	protected ownerTidFor(table: string): DatabaseActorUid | undefined {
		// owner_tid 是 NOT NULL DEFAULT 1（默认租户）。没有租户上下文时不写这一列，
		// 让数据库默认值兜底——迁移、种子、CLI 等系统写入因此落到默认租户，
		// 而不是留下 NULL：唯一索引里的 NULL 互不相等，会让 (key, owner_tid) 这类约束失效。
		const value = typeof this.tenantContext === 'function' ? this.tenantContext(table) : this.tenantContext;
		return value ?? undefined;
	}
	protected ownerBidFor(table: string): DatabaseActorUid | undefined {
		// 与 owner_tid 同样处理：没有分站上下文时不写这一列，交给数据库默认值。
		const value = typeof this.branchContext === 'function' ? this.branchContext(table) : this.branchContext;
		return value ?? undefined;
	}
	protected abstract placeholder(index: number): string;
	protected placeholders(count: number, start = 1) { return Array.from({ length: count }, (_, index) => this.placeholder(start + index)); }

	select(options: SqlSelectOptions): SqlQuery {
		const selectedColumns = options.columns && Object.keys(options.columns).length
			? Object.entries(options.columns).map(([alias, definition]) => {
				const column = typeof definition === 'string' ? quoteIdentifier(definition, this.dialect) : definition.cast === 'text' ? this.castText(definition.column) : quoteIdentifier(definition.column, this.dialect);
				return `${column} AS ${quoteIdentifier(alias, this.dialect)}`;
			})
			: [];
		if (options.sqliteRowIdAlias) {
			if (this.dialect !== 'sqlite') throw new Error('rowid is only available for SQLite');
			selectedColumns.unshift(`rowid AS ${quoteIdentifier(options.sqliteRowIdAlias, this.dialect)}`);
		}
		if (options.includeAll || !selectedColumns.length) selectedColumns.push('*');
		const columns = selectedColumns.join(', ');
		let query = `SELECT${options.distinct ? ' DISTINCT' : ''} ${columns} FROM ${quoteIdentifier(options.table, this.dialect)}${options.alias ? ` AS ${quoteIdentifier(options.alias, this.dialect)}` : ''}`;
		const deletedScope = options.deleted ?? this.defaultDeletedScope;
		const pendedScope = options.pended ?? this.defaultPendedScope;
		// 关联表的删除状态写进 ON，不写进 WHERE。写进 WHERE 会让 LEFT JOIN 退化成 INNER JOIN：
		// 没有匹配行时关联表的 deleted_at 是 NULL，而 NULL = 0 求值为 unknown，整行被过滤掉——
		// 没有资料或没有凭证的账号会从列表里凭空消失。放进 ON 对 INNER JOIN 等价。
		for (const join of options.joins ?? []) {
			const joinScope = quoteIdentifier(`${join.alias ?? join.table}.deleted_at`, this.dialect);
			const joinPended = quoteIdentifier(`${join.alias ?? join.table}.pended_at`, this.dialect);
			const activeOnly = deletedScope !== 'all' && deletedScope !== 'deleted';
			const pendedOnly = activeOnly && pendedScope === 'active';
			// 待审批的新行和已删除的行一样，都要写进 ON 而不是 WHERE，理由同上。
			query += ` ${join.type ?? 'INNER'} JOIN ${quoteIdentifier(join.table, this.dialect)}${join.alias ? ` AS ${quoteIdentifier(join.alias, this.dialect)}` : ''} ON ${quoteIdentifier(join.left, this.dialect)} = ${quoteIdentifier(join.right, this.dialect)}${activeOnly ? ` AND ${joinScope} = 0` : ''}${pendedOnly ? ` AND ${joinPended} = 0` : ''}`;
		}
		const deletedConditions: SqlCondition[] = deletedScope === 'all' ? [] : [
			{ column: `${options.alias ?? options.table}.deleted_at`, operator: deletedScope === 'deleted' ? '!=' as const : '=' as const, value: 0 },
			// 待审批的新行对所有正常查询不可见：它还没通过审批，在看的人眼里不该存在。
			// 只在 active 加：回收站（deleted）按 deleted_at != 0 取，本来就收不到它们
			// （它们的 deleted_at 是 0）；deleted: 'all' 是内部读——算差异、批准写回都要读得到。
			// pended: 'all' 是显式的例外，见 PendedScope。
			...(deletedScope === 'active' && pendedScope === 'active' ? [{ column: `${options.alias ?? options.table}.pended_at`, value: 0 }] : []),
		];
		const conditions = [...deletedConditions, ...this.visibilityConditions(options.table, options.alias), ...(options.where ?? [])], boundConditions = conditions.filter(bindsValue);
		let parameterIndex = 0;
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`;
		const selectable = Object.keys(options.columns ?? {});
		options.sort?.expose?.(selectable);
		// 请求里认不出的字段直接丢掉——那多半是换了页面结构后浏览器还留着旧地址。
		const requested = (options.sort?.request ?? []).flatMap((item) => {
			if (!selectable.includes(item.field)) return [];
			const mapped = options.columns?.[item.field];
			const column = typeof mapped === 'string' ? mapped : (mapped && typeof mapped === 'object' ? mapped.column : '');
			return column ? [{ column, direction: item.direction }] : [];
		});
		// 请求的排序排在前面，原有排序留在后面兜底：按状态这类重复值很多的列排时，
		// 同值行之间还要有个稳定的次序，否则翻页会看到同一行出现两次、另一行一次都不出现。
		const orderBy = requested.length ? [...requested, ...(options.orderBy ?? [])] : options.orderBy;
		if (orderBy?.length) query += ` ORDER BY ${orderBy.map((order) => `${quoteIdentifier(order.column, this.dialect)} ${order.direction ?? 'ASC'}`).join(', ')}`;
		if (options.limit !== undefined) { query += ` LIMIT ${this.placeholder(boundConditions.length + 1)}`; if (options.offset !== undefined) query += ` OFFSET ${this.placeholder(boundConditions.length + 2)}`; }
		return { query, values: [...boundConditions.map((condition) => condition.value as SqlValue), ...(options.limit !== undefined ? [options.limit, ...(options.offset !== undefined ? [options.offset] : [])] : [])] };
	}

	/**
	 * 与 {@link select} 同一组条件下的行数。
	 *
	 * 两个默认值都跟适配器走：翻回收站时 select 读的是已删除的那些行，count 却写死了
	 * `'active'`，于是回收站页脚报的是**主表**的总数——列表七条、底下写着「共 231 条」。
	 * 一层只把上游的作用域原样传下去，不自己另立一个。
	 */
	/**
	 * 搜索框的三态换成 WHERE 条件：**没这个参数**是不筛选，**空串**是找空的，有值才按值筛。
	 *
	 * 原先空串和缺席在传输上就是同一个东西，于是根本没有办法搜空值——想找出哪几条记录
	 * 没写操作原因，把框清掉就等于取消筛选。前端的搜索框现在分得开「未填写」和「填了空」
	 * （见 TableQueryValues），这一头照着它的三态接。
	 *
	 * 空串匹配 `IS NULL OR = ''` 两种：文本框只有「未填写」和「空」两个可表达的状态，
	 * 而「未填写」已经占去了「不筛选」，于是「空」只能是这两种存储形态的合集。这是**问法**
	 * 上的合并，不是把两者混成一滩——列表里 NULL 和空串照旧分得开（`(NULL)` 与空格子），
	 * 搜出来之后一眼可辨。真要分开筛的页面，把两种情况写成下拉框的两个选项，
	 * 别指望一个文本框能表达三件事。
	 */
	search(column: string, value: string | undefined, match: 'equals' | 'like' = 'equals'): SqlCondition[] {
		if (value === undefined) return [];
		if (value === '') {
			const quoted = quoteIdentifier(column, this.dialect);
			return [{ raw: `(${quoted} IS NULL OR ${quoted} = '')` }];
		}
		// 关键字直接当模式片段用：`%` 与 `_` 在这里就是通配符。转义需要 ESCAPE 子句，
		// 三种方言的默认转义字符并不一致，为一个搜索框引入那套规则不划算。
		return [match === 'like' ? { column, operator: 'LIKE' as const, value: `%${value}%` } : { column, value }];
	}

	count(table: string, where: SqlCondition[] = [], deleted: DeletedScope = this.defaultDeletedScope, pended: PendedScope = this.defaultPendedScope): SqlQuery {
		let query = `SELECT COUNT(*) AS ${quoteIdentifier('count', this.dialect)} FROM ${quoteIdentifier(table, this.dialect)}`;
		let parameterIndex = 0;
		const conditions: SqlCondition[] = [
			...(deleted === 'all' ? [] : [{ column: 'deleted_at', operator: deleted === 'deleted' ? '!=' as const : '=' as const, value: 0 }]),
			...(deleted === 'active' && pended === 'active' ? [{ column: 'pended_at', value: 0 }] : []),
			...this.visibilityConditions(table),
			...where,
		];
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`;
		return { query, values: conditions.filter(bindsValue).map((condition) => condition.value) };
	}

	/**
	 * @param options.pending 待审批的新建：行照写，但 `pended_at` 记下进队列的时刻，
	 * 于是它对所有正常查询不可见。批准把它归零（{@link activate}），驳回把整行物理删掉——
	 * 那一行从未生效过，历史留在审批记录上。
	 *
	 * 用一列专管「有没有通过审批」，不复用 deleted_at：那两件事的区别是「还没生出来」
	 * 与「被删掉了」，混在一列里，回收站就会把没批准的新建当成可恢复的记录列出来。
	 */
	insert(table: string, values: Values, options: { pending?: boolean } = {}): SqlQuery {
		// An internal allocator may provide an ID during creation; IDs are still
		// immutable after creation and never appear in user-facing forms.
		assertBusinessWriteFields(values, { allowId: true, allowKey: true });
		const timestamp = Date.now(), actorUid = this.actorUidFor(table), ownerUid = this.ownerUidFor(table), ownerTid = this.ownerTidFor(table), ownerBid = this.ownerBidFor(table);
		// key 和 created_at 一样由这一层补：它是每一行的稳定标识（§column-naming），
		// 漏补一处就是运行时的 NOT NULL 报错。调用方给了就用调用方的——`global_sites`
		// 这类表的 key 是人给的短串，不是雪花。
		if (values.key !== undefined) assertRowKey(table, values.key);
		const rowKey = values.key === undefined && !KEYLESS_TABLES.has(table) ? { key: nextSnowflake() } : {};
		const timestamped: Values = { created_at: timestamp, updated_at: timestamp, ...(options.pending ? { pended_at: timestamp } : {}), ...(actorUid !== null ? { created_duid: actorUid, updated_duid: actorUid } : {}), owner_tid: ownerTid, owner_bid: ownerBid, owner_uid: ownerUid, ...rowKey, ...values };
		const entries = definedEntries(timestamped); if (!entries.length) throw new Error('INSERT values cannot be empty');
		const rowKeyValue = timestamped.key;
		return {
			query: `INSERT INTO ${quoteIdentifier(table, this.dialect)} (${entries.map(([key]) => quoteIdentifier(key, this.dialect)).join(', ')}) VALUES (${this.placeholders(entries.length).join(', ')})`,
			values: entries.map(([, value]) => value),
			// key 在这里就定下来了，因此新建也能「先记录、后写行」——自增主键做不到这一点。
			...(typeof rowKeyValue === 'string' && rowKeyValue ? { insertAudit: { table, rowKey: rowKeyValue, values: timestamped, owner: { tid: this.ownerTidFor(AUDIT_TABLE), bid: this.ownerBidFor(AUDIT_TABLE), uid: this.ownerUidFor(AUDIT_TABLE), actor: this.actorUidFor(AUDIT_TABLE) } } } : {}),
		};
	}

	/** 数据库迁移专用：按源库原样写入审计字段，不供业务 API 使用。 */
	/**
	 * 数据库迁移/导入专用：审计字段按源库原样写入，不由这一层生成。
	 *
	 * `key` 仍然要补——源库（老 Passport、别的方言）里没有这一列，而它是 NOT NULL。
	 * 调用方给了就用给的，那是搬迁时保留原值的路径。
	 */
	insertExisting(table: string, values: Values): SqlQuery {
		if (values.key !== undefined) assertRowKey(table, values.key);
		const withKey: Values = values.key === undefined && !KEYLESS_TABLES.has(table) ? { key: nextSnowflake(), ...values } : values;
		const entries = definedEntries(withKey); if (!entries.length) throw new Error('INSERT values cannot be empty');
		return {
			query: `INSERT INTO ${quoteIdentifier(table, this.dialect)} (${entries.map(([key]) => quoteIdentifier(key, this.dialect)).join(', ')}) VALUES (${this.placeholders(entries.length).join(', ')})`,
			values: entries.map(([, value]) => value),
		};
	}

	/** 数据库迁移专用：按源库原样写入审计字段，并在业务唯一键冲突时跳过。 */
	ignoreInsertExisting(table: string, conflictKeys: string[], values: Values): SqlQuery {
		const inserted = this.insertExisting(table, values);
		const target = conflictTarget(conflictKeys);
		return this.dialect === 'mysql'
			? { ...inserted, query: inserted.query.replace(/^INSERT /, 'INSERT IGNORE ') }
			: { ...inserted, query: `${inserted.query} ON CONFLICT (${target.map((key) => quoteIdentifier(key, this.dialect)).join(', ')}) DO NOTHING` };
	}

	insertFromSelect(table: string, values: Record<string, InsertSelectValue>, from: string, where: SqlCondition[]): SqlQuery {
		const entries = Object.entries(values); if (!entries.length || !where.length) throw new Error('insertFromSelect values and where cannot be empty');
		let parameterIndex = 0;
		const selected = entries.map(([, value]) => value && typeof value === 'object' && 'column' in value
			? quoteIdentifier(String(value.column), this.dialect)
			: this.placeholder(++parameterIndex));
		const conditions = where.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex)));
		return {
			query: `INSERT INTO ${quoteIdentifier(table, this.dialect)} (${entries.map(([key]) => quoteIdentifier(key, this.dialect)).join(', ')}) SELECT ${selected.join(', ')} FROM ${quoteIdentifier(from, this.dialect)} WHERE ${conditions.join(' AND ')}`,
			values: [...entries.filter(([, value]) => !(value && typeof value === 'object' && 'column' in value)).map(([, value]) => value), ...where.filter(bindsValue).map((condition) => condition.value)],
		};
	}

	private updateManaged(table: string, values: Values, where: Values | SqlCondition[], allowManagedFlags = false): SqlQuery {
		assertBusinessWriteFields(values, { allowManagedFlags });
		const actorUid = this.actorUidFor(table);
		const entries = definedEntries({ updated_at: Date.now(), ...(actorUid !== null ? { updated_duid: actorUid } : {}), ...values });
		const businessConditions: SqlCondition[] = Array.isArray(where) ? where : definedEntries(where).map(([column, value]) => ({ column, value }));
		// 写入与读取用同一套判定：能改的行本就是能看到的行。影响 0 行统一表示"不存在或无权限"。
		const conditions: SqlCondition[] = [...this.visibilityConditions(table), ...businessConditions];
		if (!entries.length || !conditions.length) throw new Error('UPDATE values and where cannot be empty');
		let parameterIndex = entries.length;
		return {
			query: `UPDATE ${quoteIdentifier(table, this.dialect)} SET ${entries.map(([key], index) => `${quoteIdentifier(key, this.dialect)} = ${this.placeholder(index + 1)}`).join(', ')} WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`,
			values: [...entries.map(([, value]) => value), ...conditions.filter(bindsValue).map((condition) => condition.value as SqlValue)],
			...auditMetadata(table, values, conditions, { tid: this.ownerTidFor(AUDIT_TABLE), bid: this.ownerBidFor(AUDIT_TABLE), uid: this.ownerUidFor(AUDIT_TABLE), actor: this.actorUidFor(AUDIT_TABLE) }),
		};
	}

	update(table: string, values: Values, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, values, where);
	}

	/** 审计记录的操作者：与 insert 写进 created_duid 的是同一个值。 */
	auditActor(table: string): DatabaseActorUid | null { return this.actorUidFor(table); }

	/**
	 * 回滚专用：把审计记录里的前值写回。
	 *
	 * 与 update 的唯一区别是允许写 deleted_at——软删除与恢复的逆操作要还原它，
	 * 而 restore() 只能写 0、softDelete() 只能写当前时间，都还原不了原时间戳。
	 * where 里带上"当前值仍等于变更后的值"这组条件，回滚因此天然是条件更新。
	 */
	revert(table: string, values: Values, where: SqlCondition[]): SqlQuery {
		return this.updateManaged(table, values, where, true);
	}

	/** 将记录移入回收站；审计字段由 update 统一维护。 */
	softDelete(table: string, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, { deleted_at: Date.now() }, where, true);
	}

	/** 批准一条待审批的新建：pended_at 归零，这一行才开始对人可见。 */
	activate(table: string, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, { pended_at: 0 }, where, true);
	}

	/** 从回收站恢复记录；不会恢复已被物理清理的记录。 */
	restore(table: string, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, { deleted_at: 0 }, where, true);
	}

	/** 物理删除，仅供清理任务和明确的不可恢复操作使用。 */
	delete(table: string, where: Values | SqlCondition[]): SqlQuery {
		const businessConditions: SqlCondition[] = Array.isArray(where)
			? where
			: definedEntries(where).map(([column, value]) => ({ column, value }));
		if (!businessConditions.length) throw new Error('DELETE where cannot be empty');
		const conditions: SqlCondition[] = [...this.visibilityConditions(table), ...businessConditions];
		let parameterIndex = 0;
		return {
			query: `DELETE FROM ${quoteIdentifier(table, this.dialect)} WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`,
			values: conditions.filter(bindsValue).map((condition) => condition.value),
		};
	}

	/**
	 * 原子推进一个数字列：`column = MAX(column + step, floor)`。
	 *
	 * `step` 用来一次预留一整段（雪花号段就是这么拿的）。并发下两个请求各推一次，
	 * 谁先谁后都不会拿到重叠的区间——这正是「预留」要走数据库而不是内存的原因。
	 */
	advanceNumber(table: string, column: string, floor: number, updatedAt: number, where: Values, step = 1): SqlQuery {
		const conditions = definedEntries(where); if (!conditions.length) throw new Error('advanceNumber where cannot be empty');
		const target = quoteIdentifier(column, this.dialect), greatest = this.dialect === 'sqlite' ? 'MAX' : 'GREATEST', actorUid = this.actorUidFor(table);
		const audit = actorUid === null ? '' : `, ${quoteIdentifier('updated_duid', this.dialect)} = ${this.placeholder(3)}`;
		const whereStart = actorUid === null ? 3 : 4;
		return {
			query: `UPDATE ${quoteIdentifier(table, this.dialect)} SET ${target} = ${greatest}(${target} + ${step}, ${this.placeholder(1)}), ${quoteIdentifier('updated_at', this.dialect)} = ${this.placeholder(2)}${audit} WHERE ${conditions.map(([key], index) => `${quoteIdentifier(key, this.dialect)} = ${this.placeholder(index + whereStart)}`).join(' AND ')}`,
			values: [floor, updatedAt, ...(actorUid === null ? [] : [actorUid]), ...conditions.map(([, value]) => value)],
		};
	}

	/**
	 * 冲突时命中的那一行由**插入值**决定，因此审计要按同一组值去找原行。
	 * 归属列没写进 INSERT 时数据库会用默认值，条件也要跟着用默认值，否则找错行。
	 * 有一个键的值推不出来就整体不审计——宁可没有记录，也不要一条指错行的记录。
	 */
	private upsertAuditWhere(table: string, conflictKeys: string[], values: Values): SqlCondition[] | undefined {
		const conditions: SqlCondition[] = [];
		for (const key of conflictTarget(conflictKeys)) {
			if (values[key] !== undefined) { conditions.push({ column: key, value: values[key] }); continue; }
			if (key === 'deleted_at') { conditions.push({ column: key, value: 0 }); continue; }
			if (key === 'owner_tid') { conditions.push({ column: key, value: this.ownerTidFor(table) ?? DEFAULT_OWNER_ID }); continue; }
			if (key === 'owner_bid') { conditions.push({ column: key, value: this.ownerBidFor(table) ?? DEFAULT_OWNER_ID }); continue; }
			if (key === 'owner_uid') {
				const ownerUid = this.ownerUidFor(table);
				conditions.push(ownerUid === null ? { column: key, operator: 'IS NULL' } : { column: key, value: ownerUid });
				continue;
			}
			return undefined;
		}
		return conditions;
	}

	/**
	 * 只有冲突走 UPDATE 那一支才算变更。新插入的行读不到原值，审计的 SELECT 因此
	 * 自然返回空、不产生记录——与"insert 不审计"是同一个结果，不需要分支判断。
	 */
	upsert(table: string, conflictKeys: string[], values: Values, updateKeys: string[]): SqlQuery {
		/**
		 * **两种元数据都带上**：这条语句到底是 INSERT 还是 UPDATE，建语句的时候不知道。
		 *
		 * 由操作层查一次冲突条件来定：查得到行就是修改，查不到就是新建。它本来就要读那一行
		 * 的前值，因此不多一次查询。原先这里把 insertAudit 丢掉，于是 upsert 走 INSERT 那一支
		 * 完全不留痕——个人中心第一次设昵称(资料行还不存在)就是这条路，做完在审批表里找不到。
		 *
		 * 只有 auditWhere 拿得到时才带 insertAudit：拿不到就无从判断走的是哪一支，
		 * 宁可维持原样不记，也不能记一条可能是假的「新增」。
		 */
		const { insertAudit, ...inserted } = this.insert(table, values);
		const actorUid = this.actorUidFor(table);
		const managedUpdateKeys = [...new Set([...updateKeys, 'updated_at', ...(actorUid === null ? [] : ['updated_duid'])])];
		const quotedUpdates = managedUpdateKeys.map((key) => quoteIdentifier(key, this.dialect));
		const target = conflictTarget(conflictKeys);
		if (!quotedUpdates.length) throw new Error('UPSERT update keys cannot be empty');
		const suffix = this.dialect === 'mysql'
			? ` ON DUPLICATE KEY UPDATE ${quotedUpdates.map((key) => `${key} = VALUES(${key})`).join(', ')}`
			: ` ON CONFLICT (${target.map((key) => quoteIdentifier(key, this.dialect)).join(', ')}) DO UPDATE SET ${quotedUpdates.map((key) => `${key} = excluded.${key}`).join(', ')}`;
		const auditWhere = this.upsertAuditWhere(table, conflictKeys, values);
		const auditValues = auditWhere === undefined ? {} : Object.fromEntries(updateKeys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
		return {
			...inserted,
			query: inserted.query + suffix,
			...(auditWhere === undefined ? {} : {
				...auditMetadata(table, auditValues, auditWhere, { tid: this.ownerTidFor(AUDIT_TABLE), bid: this.ownerBidFor(AUDIT_TABLE), uid: this.ownerUidFor(AUDIT_TABLE), actor: this.actorUidFor(AUDIT_TABLE) }),
				...(insertAudit ? { insertAudit } : {}),
			}),
		};
	}

	ignoreInsert(table: string, conflictKeys: string[], values: Values): SqlQuery {
		// 冲突时什么都不做，因此不能预先记一条新建。
		const { insertAudit: _ignored, ...inserted } = this.insert(table, values);
		const target = conflictTarget(conflictKeys);
		return this.dialect === 'mysql'
			? { ...inserted, query: inserted.query.replace(/^INSERT /, 'INSERT IGNORE ') }
			: { ...inserted, query: `${inserted.query} ON CONFLICT (${target.map((key) => quoteIdentifier(key, this.dialect)).join(', ')}) DO NOTHING` };
	}

	castText(expression: string) { const quoted = quoteIdentifier(expression, this.dialect); return this.dialect === 'mysql' ? `CAST(${quoted} AS CHAR)` : `CAST(${quoted} AS TEXT)`; }
}

export class SqliteSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null, pendedScope: PendedScope = 'active') { super('sqlite', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope); } protected placeholder() { return '?'; } }
export class MysqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null, pendedScope: PendedScope = 'active') { super('mysql', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope); } protected placeholder() { return '?'; } }
export class PostgresqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null, pendedScope: PendedScope = 'active') { super('postgresql', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope); } protected placeholder(index: number) { return `$${index}`; } }

export const sql = (context: SqlContext) => {
	const dialect = dialectOf(context.database);
	const actorContext: SqlActorContext = context.actorUidForTable
		?? (Object.prototype.hasOwnProperty.call(context, 'actorUid') ? context.actorUid ?? null : context.database.actorUidForTable ?? context.database.actorUid ?? null);
	const ownerContext: SqlActorContext = context.ownerUidForTable
		?? (Object.prototype.hasOwnProperty.call(context, 'ownerUid') ? context.ownerUid ?? null : context.database.ownerUidForTable ?? context.database.ownerUid ?? null);
	const tenantContext: SqlActorContext = context.ownerTidForTable
		?? (Object.prototype.hasOwnProperty.call(context, 'ownerTid') ? context.ownerTid ?? null : context.database.ownerTidForTable ?? context.database.ownerTid ?? null);
	const branchContext: SqlActorContext = context.ownerBidForTable
		?? (Object.prototype.hasOwnProperty.call(context, 'ownerBid') ? context.ownerBid ?? null : context.database.ownerBidForTable ?? context.database.ownerBid ?? null);
	const subjectRoles = Object.prototype.hasOwnProperty.call(context, 'subjectRoles') ? context.subjectRoles ?? null : context.database.subjectRoles ?? null;
	const deletedScope = context.deletedScope ?? context.database.deletedScope ?? 'active';
	const pendedScope = context.pendedScope ?? context.database.pendedScope ?? 'active';
	return dialect === 'mysql' ? new MysqlSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope) : dialect === 'postgresql' ? new PostgresqlSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope) : new SqliteSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles, pendedScope);
};
/**
 * 记录变更后再执行。无事务可用，因此**顺序是强制的：先记录，后应用**——
 * 中断留下"记了但没做"可被发现和核对，"做了但没记"则事后无法察觉（见需求文档 §6.2）。
 * 记录失败时整个操作失败：不允许"审计写不进去就跳过"，那等于给了绕过审计的开关。
 */
/**
 * 执行一条语句，不做任何审计判断。两种用途：
 *
 * 1. 操作层执行已经记过账的语句；
 * 2. **人工请求里的机器写入**——一次表单提交里除了那个操作本身，还会顺带推进一些
 *    状态机（一次性验证码过期、会话续期）。它们发生在人工请求里，却不是人做的修改，
 *    记下来只有噪音。用这个函数是一次显式声明，读代码的人一眼能看见。
 */
export const runSystemSql = (database: DatabaseAdapter, statement: SqlQuery): Promise<DatabaseRunResult> =>
	database.prepare(statement.query).bind(...statement.values).run();

/**
 * 受管写入的看门人。
 *
 * 记录本身在操作层做（`server/modules/base/operation.mts`）：那里才知道这是哪个人、
 * 因为什么、勾没勾立即生效、这次操作包含哪几条写入。SqlBuilder 这一层看到的只是
 * 一条 SQL 片段，靠表名列名反推"算不算人工操作"只是代价高的猜测。
 *
 * 但覆盖面不能靠"记得调用 runOperation"——漏一处就少一条证据，而且没有任何征兆。
 * 所以这里保留一道断言：**人工请求里的受管写入必须走操作层**，漏包立刻报错。
 */
export const runSql = async (database: DatabaseAdapter, statement: SqlQuery): Promise<DatabaseRunResult> => {
	// 异步抛出而不是同步抛出：声明的返回类型是 Promise，同步抛会从没 await 的调用方
	// 的 .catch() 里漏出去。
	if (statement.audit && database.humanOperation) {
		throw new Error(`人工操作的受管写入必须走 runOperation：${statement.audit.table}`);
	}
	return runSystemSql(database, statement);
};

/**
 * 这个错误是不是撞了唯一索引。
 *
 * 四种方言各说各话，所以三种线索都认：驱动的错误码（mysql2 的 ER_DUP_ENTRY、
 * PostgreSQL 的 23505）、SQLite 的 errcode（2067 唯一索引 / 1555 主键），
 * 以及消息正文——D1 只给得出消息。
 *
 * 用来把「已经有一条一样的了」翻译成 409，而不是让它变成 500：撞唯一索引是
 * 用户输入的正常结果，不是服务端出错。
 */
export const isUniqueViolation = (error: unknown) => {
	if (!error || typeof error !== 'object') return false;
	const code = String((error as { code?: unknown }).code ?? '');
	if (code === 'ER_DUP_ENTRY' || code === '23505') return true;
	const errcode = Number((error as { errcode?: unknown }).errcode ?? 0);
	if (errcode === 2067 || errcode === 1555) return true;
	return /UNIQUE constraint failed|Duplicate entry|duplicate key value/i.test(String((error as { message?: unknown }).message ?? ''));
};

export const firstSql = <T,>(database: DatabaseAdapter, statement: SqlQuery) => database.prepare(statement.query).bind(...statement.values).first<T>();
export const allSql = async <T,>(database: DatabaseAdapter, statement: SqlQuery) => (await database.prepare(statement.query).bind(...statement.values).all<T>()).results;
export { compileSqlPlaceholders } from './placeholders.mjs';

/**
 * 归属列的等值条件。
 *
 * `owner_tid` / `owner_bid` 是 `NOT NULL DEFAULT 1`：没有租户上下文时写入落到默认租户 1，
 * 查询就必须同样比 1。写成 `IS NULL` 是这两列还可空时的遗留，现在永远匹配不到任何行——
 * 靠它做唯一性检查等于没做，撞名会一路放行到数据库约束（或者干脆放行）。
 */
export const ownerScope = (column: string, ownerId: string | number | bigint | null | undefined) => (
	{ column, value: ownerId ?? DEFAULT_OWNER_ID } as const
);
