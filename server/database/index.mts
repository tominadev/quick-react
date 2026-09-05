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
	/**
	 * Request-scoped default visibility for rows still awaiting approval.
	 *
	 * 与 deletedScope 分开：它们回答的是两个问题（删了没有 / 批了没有）。管理后台的
	 * 表格页把它设成 'all'——待审批的新行要出现在列表里，管理员才能在那里直接撤销或批准。
	 */
	pendedScope?: 'active' | 'all';
	/** Request-scoped audit actor used by the SQL builder. */
	actorUid?: DatabaseActorUid;
	/** Optional table-aware actor, needed when Base and Passport share a DB. */
	actorUidForTable?: DatabaseActorResolver;
	/** Request-scoped user that owns a newly inserted row. */
	ownerUid?: DatabaseActorUid;
	/** Optional table-aware owner user, needed when Base and Passport share a DB. */
	ownerUidForTable?: DatabaseActorResolver;
	/** Request-scoped tenant that owns a newly inserted row. */
	ownerTid?: DatabaseActorUid;
	/** Optional table-aware owner tenant, needed when Base and Passport share a DB. */
	ownerTidForTable?: DatabaseActorResolver;
	/**
	 * 当前主体的角色。`null` 或缺省表示系统上下文，完全跳过行级判定；
	 * 绑定了数组（哪怕为空）就受判定约束。
	 */
	subjectRoles?: readonly string[] | null;
	/**
	 * 这次请求是不是人工操作（管理后台与账户中心的表单提交）。
	 * 为 true 时受管写入必须走 runOperation，否则 runSql 直接报错。
	 */
	humanOperation?: boolean;
	/** Request-scoped branch that owns a newly inserted row. */
	ownerBid?: DatabaseActorUid;
	/** Optional table-aware owner branch, needed when Base and Passport share a DB. */
	ownerBidForTable?: DatabaseActorResolver;
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

/** Bind an approval-queue visibility scope to the request-scoped adapter. */
export const withDatabasePendedScope = (database: DatabaseAdapter, pendedScope: NonNullable<DatabaseAdapter['pendedScope']>): DatabaseAdapter => {
	const scoped: DatabaseAdapter = { ...database, pendedScope };
	if (database.transaction) {
		scoped.transaction = (callback) => database.transaction!((transactionDatabase) => callback(withDatabasePendedScope(transactionDatabase, pendedScope)));
	}
	return scoped;
};

export type DatabaseActors = {
	/** 主体角色；绑定后该适配器上的读写都受行级判定约束。 */
	subjectRoles?: readonly string[] | null;
	/** 这次请求是不是人工操作；由 worker.mts 按请求路径设置。 */
	humanOperation?: boolean;
	base?: DatabaseActorUid;
	passport?: DatabaseActorUid;
	baseUserId?: DatabaseActorUid;
	passportUserId?: DatabaseActorUid;
	baseTenantId?: DatabaseActorUid;
	passportTenantId?: DatabaseActorUid;
	baseBranchId?: DatabaseActorUid;
	passportBranchId?: DatabaseActorUid;
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
	const hasBaseTenant = Object.prototype.hasOwnProperty.call(actors, 'baseTenantId');
	const hasPassportTenant = Object.prototype.hasOwnProperty.call(actors, 'passportTenantId');
	const hasBaseBranch = Object.prototype.hasOwnProperty.call(actors, 'baseBranchId');
	const hasPassportBranch = Object.prototype.hasOwnProperty.call(actors, 'passportBranchId');
	const inherited = (table: string) => database.actorUidForTable?.(table) ?? database.actorUid ?? null;
	const inheritedOwner = (table: string) => database.ownerUidForTable?.(table) ?? database.ownerUid ?? null;
	const inheritedTenant = (table: string) => database.ownerTidForTable?.(table) ?? database.ownerTid ?? null;
	const inheritedBranch = (table: string) => database.ownerBidForTable?.(table) ?? database.ownerBid ?? null;
	const bound: DatabaseAdapter = {
		...database,
		...(Object.prototype.hasOwnProperty.call(actors, 'subjectRoles') ? { subjectRoles: actors.subjectRoles ?? null } : {}),
		...(Object.prototype.hasOwnProperty.call(actors, 'humanOperation') ? { humanOperation: actors.humanOperation ?? false } : {}),
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
		ownerTidForTable: (table) => {
			if (table.startsWith('passport_') && hasPassportTenant) return actors.passportTenantId ?? null;
			if (!table.startsWith('passport_') && hasBaseTenant) return actors.baseTenantId ?? null;
			return inheritedTenant(table);
		},
		ownerBidForTable: (table) => {
			if (table.startsWith('passport_') && hasPassportBranch) return actors.passportBranchId ?? null;
			if (!table.startsWith('passport_') && hasBaseBranch) return actors.baseBranchId ?? null;
			return inheritedBranch(table);
		},
	};
	if (database.transaction) {
		bound.transaction = (callback) =>
			database.transaction!((transactionDatabase) => {
			const scopedTransaction = withDatabaseActors(transactionDatabase, actors);
			return callback({ ...scopedTransaction, ...(database.deletedScope ? { deletedScope: database.deletedScope } : {}), ...(database.pendedScope ? { pendedScope: database.pendedScope } : {}) });
		});
	}
	return bound;
};

export type DatabaseTarget = {
	kind: 'default' | 'binding' | 'dsn';
	value: string;
};
