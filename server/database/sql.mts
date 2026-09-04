import type { DatabaseAdapter, DatabaseActorResolver, DatabaseActorUid, DatabaseRunResult } from './index.mjs';
import { isSystemField, SYSTEM_FIELD_NAMES } from '@shared/system-fields.mjs';
import { hasAuditableColumns, isAuditedTable, isNonAuditedColumn } from '@shared/audit-tables.mjs';

export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql';
export type SqlActorContext = DatabaseActorUid | DatabaseActorResolver;
export type SqlContext = { database: DatabaseAdapter; actorUid?: DatabaseActorUid; actorUidForTable?: DatabaseActorResolver; ownerUid?: DatabaseActorUid; ownerUidForTable?: DatabaseActorResolver; ownerTid?: DatabaseActorUid; ownerTidForTable?: DatabaseActorResolver; ownerBid?: DatabaseActorUid; ownerBidForTable?: DatabaseActorResolver; subjectRoles?: readonly string[] | null; deletedScope?: DeletedScope };
/**
 * update 附带的变更留痕元信息，由 runSql 消费：读原行、比对、记录，然后才执行。
 * SqlBuilder 保持纯函数，多步副作用放不进去（见需求文档 §6.1）。业务代码不构造也不读取它。
 */
export type SqlAuditOwnership = { tid?: DatabaseActorUid; bid?: DatabaseActorUid; uid: DatabaseActorUid | null; actor: DatabaseActorUid | null };
export type SqlAuditMetadata = { table: string; values: Values; where: SqlCondition[]; owner: SqlAuditOwnership };
export type SqlQuery = { query: string; values: unknown[]; audit?: SqlAuditMetadata };
type SqlValue = unknown;
type Values = Record<string, SqlValue | undefined>;
type InsertSelectValue = SqlValue | { column: string };
export type DeletedScope = 'active' | 'deleted' | 'all';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const quoteIdentifier = (identifier: string, dialect: SqlDialect) => {
	const parts = identifier.split('.');
	if (!parts.every((part) => identifierPattern.test(part))) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return parts.map((part) => dialect === 'mysql' ? `\`${part}\`` : `"${part}"`).join('.');
};

const dialectOf = (database: DatabaseAdapter): SqlDialect => database.dialect ?? 'sqlite';
const definedEntries = (values: Values) => Object.entries(values).filter((entry): entry is [string, SqlValue] => entry[1] !== undefined);
/** All business uniqueness is scoped to active rows so soft-deleted identifiers can be recreated. */
const conflictTarget = (keys: string[]) => {
	if (!keys.length) throw new Error('INSERT conflict keys cannot be empty');
	return keys.includes('deleted_at') ? keys : [...keys, 'deleted_at'];
};
const assertBusinessWriteFields = (values: Values, options: { allowId?: boolean; allowDeletedAt?: boolean } = {}) => {
	const protectedFields = Object.keys(values).filter((field) => isSystemField(field)
		&& !(options.allowId && field === 'id')
		&& !(options.allowDeletedAt && field === 'deleted_at'));
	if (protectedFields.length) throw new Error(`系统字段由 SQL 公共层维护，业务代码不得传入：${protectedFields.join('、')}（固定字段：${SYSTEM_FIELD_NAMES.join('、')}）`);
};

/**
 * `raw` 变体只供公共层内部构造（行级判定的常量条件），不对业务代码开放：
 * 它绕过 quoteIdentifier 的标识符校验，业务传入等于开了一个拼 SQL 的口子。
 */
export type SqlCondition =
	| { column: string; value?: SqlValue; operator?: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'IS NULL' | 'IS NOT NULL'; raw?: undefined }
	| { raw: string; column?: undefined; value?: undefined; operator?: undefined };

/** 该条件是否需要绑定一个参数值。raw 与 IS NULL 系列都不绑定。 */
/** 审计表与它自己的动作常量。审计表自身不被审计，否则记录一条变更会再产生一条变更。 */
export const AUDIT_TABLE = 'base_audit_entries';
export type SqlAuditAction = 'update' | 'soft_delete' | 'restore';
export type SqlAuditChange = { before: SqlValue; after: SqlValue };
export type SqlAuditChanges = Record<string, SqlAuditChange>;

/**
 * 两层过滤（需求文档 §3.1、§3.2）都只看表名和写入的列名，**不需要读原行**：
 * 白名单外的表、只碰心跳列的更新，在这里就短路，代价为零。
 * 确实可能有业务列变化时才附上元信息，由 runSql 去读原行逐列比对。
 */
const auditMetadata = (table: string, values: Values, where: SqlCondition[], owner: SqlAuditOwnership): { audit?: SqlAuditMetadata } => {
	if (!isAuditedTable(table)) return {};
	const audited = definedEntries(values).filter(([column]) => !isNonAuditedColumn(column));
	if (!audited.length || !hasAuditableColumns(audited.map(([column]) => column))) return {};
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
export type SqlSelectOptions = { table: string; alias?: string; distinct?: boolean; columns?: Record<string, SqlColumn>; includeAll?: boolean; sqliteRowIdAlias?: string; joins?: SqlJoin[]; where?: SqlCondition[]; orderBy?: Array<{ column: string; direction?: 'ASC' | 'DESC' }>; limit?: number; offset?: number; deleted?: DeletedScope };

export abstract class SqlBuilder {
	constructor(readonly dialect: SqlDialect, readonly actorContext: SqlActorContext = null, readonly defaultDeletedScope: DeletedScope = 'active', readonly ownerContext: SqlActorContext = null, readonly tenantContext: SqlActorContext = null, readonly branchContext: SqlActorContext = null, readonly subjectRoles: readonly string[] | null = null) {}

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
		for (const join of options.joins ?? []) query += ` ${join.type ?? 'INNER'} JOIN ${quoteIdentifier(join.table, this.dialect)}${join.alias ? ` AS ${quoteIdentifier(join.alias, this.dialect)}` : ''} ON ${quoteIdentifier(join.left, this.dialect)} = ${quoteIdentifier(join.right, this.dialect)}`;
		const deletedScope = options.deleted ?? this.defaultDeletedScope;
		const deletedConditions: SqlCondition[] = deletedScope === 'all' ? [] : [
			{ column: `${options.alias ?? options.table}.deleted_at`, operator: deletedScope === 'deleted' ? '!=' as const : '=' as const, value: 0 },
			// 回收站查看主表的已删除记录；关联表保持正常可见，避免主表记录因仍 active 的关系数据而消失。
			...(deletedScope === 'deleted' ? [] : (options.joins ?? []).map((join) => ({ column: `${join.alias ?? join.table}.deleted_at`, operator: '=' as const, value: 0 }))),
		];
		const conditions = [...deletedConditions, ...this.visibilityConditions(options.table, options.alias), ...(options.where ?? [])], boundConditions = conditions.filter(bindsValue);
		let parameterIndex = 0;
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`;
		if (options.orderBy?.length) query += ` ORDER BY ${options.orderBy.map((order) => `${quoteIdentifier(order.column, this.dialect)} ${order.direction ?? 'ASC'}`).join(', ')}`;
		if (options.limit !== undefined) { query += ` LIMIT ${this.placeholder(boundConditions.length + 1)}`; if (options.offset !== undefined) query += ` OFFSET ${this.placeholder(boundConditions.length + 2)}`; }
		return { query, values: [...boundConditions.map((condition) => condition.value as SqlValue), ...(options.limit !== undefined ? [options.limit, ...(options.offset !== undefined ? [options.offset] : [])] : [])] };
	}

	count(table: string, where: SqlCondition[] = [], deleted: DeletedScope = 'active'): SqlQuery {
		let query = `SELECT COUNT(*) AS ${quoteIdentifier('count', this.dialect)} FROM ${quoteIdentifier(table, this.dialect)}`;
		let parameterIndex = 0;
		const conditions: SqlCondition[] = [
			...(deleted === 'all' ? [] : [{ column: 'deleted_at', operator: deleted === 'deleted' ? '!=' as const : '=' as const, value: 0 }]),
			...this.visibilityConditions(table),
			...where,
		];
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => renderCondition(condition, this.dialect, () => this.placeholder(++parameterIndex))).join(' AND ')}`;
		return { query, values: conditions.filter(bindsValue).map((condition) => condition.value) };
	}

	insert(table: string, values: Values): SqlQuery {
		// An internal allocator may provide an ID during creation; IDs are still
		// immutable after creation and never appear in user-facing forms.
		assertBusinessWriteFields(values, { allowId: true });
		const timestamp = Date.now(), actorUid = this.actorUidFor(table), ownerUid = this.ownerUidFor(table), ownerTid = this.ownerTidFor(table), ownerBid = this.ownerBidFor(table);
		const timestamped: Values = { created_at: timestamp, updated_at: timestamp, ...(actorUid !== null ? { created_duid: actorUid, updated_duid: actorUid } : {}), owner_tid: ownerTid, owner_bid: ownerBid, owner_uid: ownerUid, ...values };
		const entries = definedEntries(timestamped); if (!entries.length) throw new Error('INSERT values cannot be empty');
		return {
			query: `INSERT INTO ${quoteIdentifier(table, this.dialect)} (${entries.map(([key]) => quoteIdentifier(key, this.dialect)).join(', ')}) VALUES (${this.placeholders(entries.length).join(', ')})`,
			values: entries.map(([, value]) => value),
		};
	}

	/** 数据库迁移专用：按源库原样写入审计字段，不供业务 API 使用。 */
	insertExisting(table: string, values: Values): SqlQuery {
		const entries = definedEntries(values); if (!entries.length) throw new Error('INSERT values cannot be empty');
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

	private updateManaged(table: string, values: Values, where: Values | SqlCondition[], allowDeletedAt = false): SqlQuery {
		assertBusinessWriteFields(values, { allowDeletedAt });
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

	/**
	 * 撤回专用：把审计记录里的前值写回。
	 *
	 * 与 update 的唯一区别是允许写 deleted_at——软删除与恢复的逆操作要还原它，
	 * 而 restore() 只能写 0、softDelete() 只能写当前时间，都还原不了原时间戳。
	 * where 里带上"当前值仍等于变更后的值"这组条件，撤回因此天然是条件更新。
	 */
	revert(table: string, values: Values, where: SqlCondition[]): SqlQuery {
		return this.updateManaged(table, values, where, true);
	}

	/** 将记录移入回收站；审计字段由 update 统一维护。 */
	softDelete(table: string, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, { deleted_at: Date.now() }, where, true);
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

	advanceNumber(table: string, column: string, floor: number, updatedAt: number, where: Values): SqlQuery {
		const conditions = definedEntries(where); if (!conditions.length) throw new Error('advanceNumber where cannot be empty');
		const target = quoteIdentifier(column, this.dialect), greatest = this.dialect === 'sqlite' ? 'MAX' : 'GREATEST', actorUid = this.actorUidFor(table);
		const audit = actorUid === null ? '' : `, ${quoteIdentifier('updated_duid', this.dialect)} = ${this.placeholder(3)}`;
		const whereStart = actorUid === null ? 3 : 4;
		return {
			query: `UPDATE ${quoteIdentifier(table, this.dialect)} SET ${target} = ${greatest}(${target} + 1, ${this.placeholder(1)}), ${quoteIdentifier('updated_at', this.dialect)} = ${this.placeholder(2)}${audit} WHERE ${conditions.map(([key], index) => `${quoteIdentifier(key, this.dialect)} = ${this.placeholder(index + whereStart)}`).join(' AND ')}`,
			values: [floor, updatedAt, ...(actorUid === null ? [] : [actorUid]), ...conditions.map(([, value]) => value)],
		};
	}

	upsert(table: string, conflictKeys: string[], values: Values, updateKeys: string[]): SqlQuery {
		const inserted = this.insert(table, values), actorUid = this.actorUidFor(table);
		const managedUpdateKeys = [...new Set([...updateKeys, 'updated_at', ...(actorUid === null ? [] : ['updated_duid'])])];
		const quotedUpdates = managedUpdateKeys.map((key) => quoteIdentifier(key, this.dialect));
		const target = conflictTarget(conflictKeys);
		if (!quotedUpdates.length) throw new Error('UPSERT update keys cannot be empty');
		const suffix = this.dialect === 'mysql'
			? ` ON DUPLICATE KEY UPDATE ${quotedUpdates.map((key) => `${key} = VALUES(${key})`).join(', ')}`
			: ` ON CONFLICT (${target.map((key) => quoteIdentifier(key, this.dialect)).join(', ')}) DO UPDATE SET ${quotedUpdates.map((key) => `${key} = excluded.${key}`).join(', ')}`;
		return { ...inserted, query: inserted.query + suffix };
	}

	ignoreInsert(table: string, conflictKeys: string[], values: Values): SqlQuery {
		const inserted = this.insert(table, values);
		const target = conflictTarget(conflictKeys);
		return this.dialect === 'mysql'
			? { ...inserted, query: inserted.query.replace(/^INSERT /, 'INSERT IGNORE ') }
			: { ...inserted, query: `${inserted.query} ON CONFLICT (${target.map((key) => quoteIdentifier(key, this.dialect)).join(', ')}) DO NOTHING` };
	}

	castText(expression: string) { const quoted = quoteIdentifier(expression, this.dialect); return this.dialect === 'mysql' ? `CAST(${quoted} AS CHAR)` : `CAST(${quoted} AS TEXT)`; }
}

export class SqliteSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null) { super('sqlite', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles); } protected placeholder() { return '?'; } }
export class MysqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null) { super('mysql', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles); } protected placeholder() { return '?'; } }
export class PostgresqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null, deletedScope: DeletedScope = 'active', ownerContext: SqlActorContext = null, tenantContext: SqlActorContext = null, branchContext: SqlActorContext = null, subjectRoles: readonly string[] | null = null) { super('postgresql', actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles); } protected placeholder(index: number) { return `$${index}`; } }

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
	return dialect === 'mysql' ? new MysqlSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles) : dialect === 'postgresql' ? new PostgresqlSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles) : new SqliteSqlBuilder(actorContext, deletedScope, ownerContext, tenantContext, branchContext, subjectRoles);
};
/**
 * 记录变更后再执行。无事务可用，因此**顺序是强制的：先记录，后应用**——
 * 中断留下"记了但没做"可被发现和核对，"做了但没记"则事后无法察觉（见需求文档 §6.2）。
 * 记录失败时整个操作失败：不允许"审计写不进去就跳过"，那等于给了绕过审计的开关。
 */
/**
 * 跨方言比较：驱动对 BIGINT 的返回类型不一致（number / string / bigint），
 * 直接用 !== 会把"没变"误判成"变了"。归一成字符串比较，null 与 undefined 同义。
 */
const sameAuditValue = (left: SqlValue, right: SqlValue) => {
	if (left === null || left === undefined) return right === null || right === undefined;
	if (right === null || right === undefined) return false;
	return String(left) === String(right);
};

/** 三种动作都是 UPDATE，按写入的列区分：碰了 deleted_at 就是删除或恢复。 */
const auditActionOf = (changes: SqlAuditChanges): SqlAuditAction => {
	const deletedAt = changes.deleted_at;
	if (!deletedAt) return 'update';
	return Number(deletedAt.after ?? 0) === 0 ? 'restore' : 'soft_delete';
};

const recordAuditEntries = async (database: DatabaseAdapter, metadata: SqlAuditMetadata) => {
	// subjectRoles 为 null：可见性判定已经算进 metadata.where 了，再算一遍会重复追加条件。
	// 归属取自生成语句时的上下文，保证审计记录与被改动的行落在同一租户、同一分站。
	const builder = sql({ database, subjectRoles: null, ownerTid: metadata.owner.tid, ownerBid: metadata.owner.bid, ownerUid: metadata.owner.uid, actorUid: metadata.owner.actor });
	const columns = Object.keys(metadata.values);
	// deleted: 'all' 与 update 的行为对齐——updateManaged 不追加删除状态条件，
	// 因此恢复操作要能读到已删除的原行，否则 restore 永远记不出变更。
	const rows = await allSql<Record<string, SqlValue>>(database, builder.select({
		table: metadata.table,
		// 一律 cast 成文本：BIGINT 是雪花号，按数字读会溢出（服务端适配器没开 readBigInts）。
		// 项目里读 ID 本就是这个写法，写回时由列的类型亲和性还原成整数。
		columns: Object.fromEntries(['id', ...columns].map((column) => [column, { column, cast: 'text' as const }])),
		where: metadata.where,
		deleted: 'all',
	}));
	for (const row of rows) {
		const changes: SqlAuditChanges = {};
		// 只记实际发生变化的列：业务表单常整体提交，照单全收会让"改了什么"失去答案。
		for (const column of columns) {
			const before = row[column] ?? null, after = metadata.values[column] ?? null;
			if (!sameAuditValue(before, after)) changes[column] = { before, after };
		}
		if (!Object.keys(changes).length) continue;
		await runSql(database, builder.insert(AUDIT_TABLE, {
			table_name: metadata.table,
			row_id: row.id,
			action: auditActionOf(changes),
			changes: JSON.stringify(changes),
			status: 'applied',
		}));
	}
};

export const runSql = async (database: DatabaseAdapter, statement: SqlQuery): Promise<DatabaseRunResult> => {
	if (statement.audit) await recordAuditEntries(database, statement.audit);
	return database.prepare(statement.query).bind(...statement.values).run();
};
export const firstSql = <T,>(database: DatabaseAdapter, statement: SqlQuery) => database.prepare(statement.query).bind(...statement.values).first<T>();
export const allSql = async <T,>(database: DatabaseAdapter, statement: SqlQuery) => (await database.prepare(statement.query).bind(...statement.values).all<T>()).results;
export { compileSqlPlaceholders } from './placeholders.mjs';
