import type { DatabaseAdapter, DatabaseActorResolver, DatabaseActorUid, DatabaseRunResult } from './index.mjs';
import { isSystemField, SYSTEM_FIELD_NAMES } from '@shared/system-fields.mjs';

export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql';
export type SqlActorContext = DatabaseActorUid | DatabaseActorResolver;
export type SqlContext = { database: DatabaseAdapter; actorUid?: DatabaseActorUid; actorUidForTable?: DatabaseActorResolver };
export type SqlQuery = { query: string; values: unknown[] };
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

export type SqlCondition = { column: string; value?: SqlValue; operator?: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'IS NULL' | 'IS NOT NULL' };
export type SqlJoin = { type?: 'INNER' | 'LEFT'; table: string; alias?: string; left: string; right: string };
export type SqlColumn = string | { column: string; cast?: 'text' };
/** Normal queries see active rows; recycle-bin code must explicitly request deleted/all rows. */
export type SqlSelectOptions = { table: string; alias?: string; distinct?: boolean; columns?: Record<string, SqlColumn>; includeAll?: boolean; sqliteRowIdAlias?: string; joins?: SqlJoin[]; where?: SqlCondition[]; orderBy?: Array<{ column: string; direction?: 'ASC' | 'DESC' }>; limit?: number; offset?: number; deleted?: DeletedScope };

export abstract class SqlBuilder {
	constructor(readonly dialect: SqlDialect, readonly actorContext: SqlActorContext = null) {}
	protected actorUidFor(table: string): DatabaseActorUid | null {
		const value = typeof this.actorContext === 'function' ? this.actorContext(table) : this.actorContext;
		return value ?? null;
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
		const deletedScope = options.deleted ?? 'active';
		const deletedConditions: SqlCondition[] = deletedScope === 'all' ? [] : [
			{ column: `${options.alias ?? options.table}.deleted_at`, operator: deletedScope === 'deleted' ? '!=' : '=', value: 0 },
			...(options.joins ?? []).map((join) => ({ column: `${join.alias ?? join.table}.deleted_at`, operator: deletedScope === 'deleted' ? '!=' as const : '=' as const, value: 0 })),
		];
		const conditions = [...deletedConditions, ...(options.where ?? [])], boundConditions = conditions.filter((condition) => !['IS NULL', 'IS NOT NULL'].includes(condition.operator ?? ''));
		let parameterIndex = 0;
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => {
			const operator = condition.operator ?? '=';
			return ['IS NULL', 'IS NOT NULL'].includes(operator) ? `${quoteIdentifier(condition.column, this.dialect)} ${operator}` : `${quoteIdentifier(condition.column, this.dialect)} ${operator} ${this.placeholder(++parameterIndex)}`;
		}).join(' AND ')}`;
		if (options.orderBy?.length) query += ` ORDER BY ${options.orderBy.map((order) => `${quoteIdentifier(order.column, this.dialect)} ${order.direction ?? 'ASC'}`).join(', ')}`;
		if (options.limit !== undefined) { query += ` LIMIT ${this.placeholder(boundConditions.length + 1)}`; if (options.offset !== undefined) query += ` OFFSET ${this.placeholder(boundConditions.length + 2)}`; }
		return { query, values: [...boundConditions.map((condition) => condition.value as SqlValue), ...(options.limit !== undefined ? [options.limit, ...(options.offset !== undefined ? [options.offset] : [])] : [])] };
	}

	count(table: string, where: SqlCondition[] = [], deleted: DeletedScope = 'active'): SqlQuery {
		let query = `SELECT COUNT(*) AS ${quoteIdentifier('count', this.dialect)} FROM ${quoteIdentifier(table, this.dialect)}`;
		let parameterIndex = 0;
		const conditions: SqlCondition[] = deleted === 'all' ? where : [{ column: 'deleted_at', operator: deleted === 'deleted' ? '!=' : '=', value: 0 }, ...where];
		if (conditions.length) query += ` WHERE ${conditions.map((condition) => {
			const operator = condition.operator ?? '=';
			return ['IS NULL', 'IS NOT NULL'].includes(operator) ? `${quoteIdentifier(condition.column, this.dialect)} ${operator}` : `${quoteIdentifier(condition.column, this.dialect)} ${operator} ${this.placeholder(++parameterIndex)}`;
		}).join(' AND ')}`;
		return { query, values: conditions.filter((condition) => !['IS NULL', 'IS NOT NULL'].includes(condition.operator ?? '')).map((condition) => condition.value) };
	}

	insert(table: string, values: Values): SqlQuery {
		// An internal allocator may provide an ID during creation; IDs are still
		// immutable after creation and never appear in user-facing forms.
		assertBusinessWriteFields(values, { allowId: true });
		const timestamp = Date.now(), actorUid = this.actorUidFor(table);
		const timestamped: Values = { created_at: timestamp, updated_at: timestamp, ...(actorUid !== null ? { created_duid: actorUid, updated_duid: actorUid } : {}), ...values };
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
		const conditions = where.map((condition) => {
			const operator = condition.operator ?? '=';
			return ['IS NULL', 'IS NOT NULL'].includes(operator) ? `${quoteIdentifier(condition.column, this.dialect)} ${operator}` : `${quoteIdentifier(condition.column, this.dialect)} ${operator} ${this.placeholder(++parameterIndex)}`;
		});
		return {
			query: `INSERT INTO ${quoteIdentifier(table, this.dialect)} (${entries.map(([key]) => quoteIdentifier(key, this.dialect)).join(', ')}) SELECT ${selected.join(', ')} FROM ${quoteIdentifier(from, this.dialect)} WHERE ${conditions.join(' AND ')}`,
			values: [...entries.filter(([, value]) => !(value && typeof value === 'object' && 'column' in value)).map(([, value]) => value), ...where.filter((condition) => !['IS NULL', 'IS NOT NULL'].includes(condition.operator ?? '')).map((condition) => condition.value)],
		};
	}

	private updateManaged(table: string, values: Values, where: Values | SqlCondition[], allowDeletedAt = false): SqlQuery {
		assertBusinessWriteFields(values, { allowDeletedAt });
		const actorUid = this.actorUidFor(table);
		const entries = definedEntries({ updated_at: Date.now(), ...(actorUid !== null ? { updated_duid: actorUid } : {}), ...values }), conditions: SqlCondition[] = Array.isArray(where) ? where : definedEntries(where).map(([column, value]) => ({ column, value }));
		if (!entries.length || !conditions.length) throw new Error('UPDATE values and where cannot be empty');
		let parameterIndex = entries.length;
		return {
			query: `UPDATE ${quoteIdentifier(table, this.dialect)} SET ${entries.map(([key], index) => `${quoteIdentifier(key, this.dialect)} = ${this.placeholder(index + 1)}`).join(', ')} WHERE ${conditions.map((condition) => {
				const operator = condition.operator ?? '=';
				return ['IS NULL', 'IS NOT NULL'].includes(operator) ? `${quoteIdentifier(condition.column, this.dialect)} ${operator}` : `${quoteIdentifier(condition.column, this.dialect)} ${operator} ${this.placeholder(++parameterIndex)}`;
			}).join(' AND ')}`,
			values: [...entries.map(([, value]) => value), ...conditions.filter((condition) => !['IS NULL', 'IS NOT NULL'].includes(condition.operator ?? '')).map((condition) => condition.value as SqlValue)],
		};
	}

	update(table: string, values: Values, where: Values | SqlCondition[]): SqlQuery {
		return this.updateManaged(table, values, where);
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
	delete(table: string, where: Values): SqlQuery {
		const conditions = definedEntries(where); if (!conditions.length) throw new Error('DELETE where cannot be empty');
		return { query: `DELETE FROM ${quoteIdentifier(table, this.dialect)} WHERE ${conditions.map(([key], index) => `${quoteIdentifier(key, this.dialect)} = ${this.placeholder(index + 1)}`).join(' AND ')}`, values: conditions.map(([, value]) => value) };
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

export class SqliteSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null) { super('sqlite', actorContext); } protected placeholder() { return '?'; } }
export class MysqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null) { super('mysql', actorContext); } protected placeholder() { return '?'; } }
export class PostgresqlSqlBuilder extends SqlBuilder { constructor(actorContext: SqlActorContext = null) { super('postgresql', actorContext); } protected placeholder(index: number) { return `$${index}`; } }

export const sql = (context: SqlContext) => {
	const dialect = dialectOf(context.database);
	const actorContext: SqlActorContext = context.actorUidForTable
		?? (Object.prototype.hasOwnProperty.call(context, 'actorUid') ? context.actorUid ?? null : context.database.actorUidForTable ?? context.database.actorUid ?? null);
	return dialect === 'mysql' ? new MysqlSqlBuilder(actorContext) : dialect === 'postgresql' ? new PostgresqlSqlBuilder(actorContext) : new SqliteSqlBuilder(actorContext);
};
export const runSql = (database: DatabaseAdapter, statement: SqlQuery): Promise<DatabaseRunResult> => database.prepare(statement.query).bind(...statement.values).run();
export const firstSql = <T,>(database: DatabaseAdapter, statement: SqlQuery) => database.prepare(statement.query).bind(...statement.values).first<T>();
export const allSql = async <T,>(database: DatabaseAdapter, statement: SqlQuery) => (await database.prepare(statement.query).bind(...statement.values).all<T>()).results;
export { compileSqlPlaceholders } from './placeholders.mjs';
