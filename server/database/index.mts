export type DatabaseRunResult = {
	success?: boolean;
	meta?: Record<string, unknown>;
};

export type DatabaseBatchStatement = {
	query: string;
	values?: unknown[];
};

export type DatabaseStatement = {
	bind: (...values: unknown[]) => DatabaseStatement;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
	all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
	run: () => Promise<DatabaseRunResult>;
};

/**
 * The device-user ID that owns a database write.  It is deliberately kept on
 * the request-scoped adapter rather than passed through every business route.
 */
export type DatabaseActorUid = string | number | bigint | null;
export type DatabaseActorResolver = (table: string) => DatabaseActorUid | undefined;

export type DatabaseAdapter = {
	dialect?: 'sqlite' | 'mysql' | 'postgresql';
	/** Request-scoped default visibility for soft-deleted records. */
	deletedScope?: 'active' | 'deleted' | 'all';
	/** Request-scoped audit actor used by the SQL builder. */
	actorUid?: DatabaseActorUid;
	/** Optional table-aware actor, needed when Base and Passport share a DB. */
	actorUidForTable?: DatabaseActorResolver;
	/** Request-scoped user that owns a newly inserted row. */
	ownerUid?: DatabaseActorUid;
	/** Optional table-aware owner user, needed when Base and Passport share a DB. */
	ownerUidForTable?: DatabaseActorResolver;
	prepare: (query: string) => DatabaseStatement;
	batch?: (statements: DatabaseBatchStatement[]) => Promise<DatabaseRunResult[]>;
	exec?: (query: string) => Promise<void>;
	transaction?: <T>(callback: (database: DatabaseAdapter) => Promise<T>) => Promise<T>;
	close?: () => void | Promise<void>;
};

/** Bind a soft-delete visibility scope to the request-scoped adapter. */
export const withDatabaseDeletedScope = (database: DatabaseAdapter, deletedScope: NonNullable<DatabaseAdapter['deletedScope']>): DatabaseAdapter => {
	const scoped: DatabaseAdapter = { ...database, deletedScope };
	if (database.transaction) {
		scoped.transaction = (callback) => database.transaction!((transactionDatabase) => callback(withDatabaseDeletedScope(transactionDatabase, deletedScope)));
	}
	return scoped;
};

export type DatabaseActors = {
	base?: DatabaseActorUid;
	passport?: DatabaseActorUid;
	baseUserId?: DatabaseActorUid;
	passportUserId?: DatabaseActorUid;
};

/**
 * Bind session actors to a request-scoped adapter.  Transactions receive a
 * similarly bound adapter so writes made inside a transaction retain audit
 * context.  An explicitly supplied `null` means a system/no-device action.
 */
export const withDatabaseActors = (database: DatabaseAdapter, actors: DatabaseActors): DatabaseAdapter => {
	const hasBase = Object.prototype.hasOwnProperty.call(actors, 'base');
	const hasPassport = Object.prototype.hasOwnProperty.call(actors, 'passport');
	const hasBaseUser = Object.prototype.hasOwnProperty.call(actors, 'baseUserId');
	const hasPassportUser = Object.prototype.hasOwnProperty.call(actors, 'passportUserId');
	const inherited = (table: string) => database.actorUidForTable?.(table) ?? database.actorUid ?? null;
	const inheritedOwner = (table: string) => database.ownerUidForTable?.(table) ?? database.ownerUid ?? null;
	const bound: DatabaseAdapter = {
		...database,
		actorUidForTable: (table) => {
			if (table.startsWith('passport_') && hasPassport) return actors.passport ?? null;
			if (!table.startsWith('passport_') && hasBase) return actors.base ?? null;
			return inherited(table);
		},
		ownerUidForTable: (table) => {
			if (table.startsWith('passport_') && hasPassportUser) return actors.passportUserId ?? null;
			if (!table.startsWith('passport_') && hasBaseUser) return actors.baseUserId ?? null;
			return inheritedOwner(table);
		},
	};
	if (database.transaction) {
		bound.transaction = (callback) =>
			database.transaction!((transactionDatabase) => {
			const scopedTransaction = withDatabaseActors(transactionDatabase, actors);
			return callback(database.deletedScope ? { ...scopedTransaction, deletedScope: database.deletedScope } : scopedTransaction);
		});
	}
	return bound;
};

export type DatabaseTarget = {
	kind: 'default' | 'binding' | 'dsn';
	value: string;
};
