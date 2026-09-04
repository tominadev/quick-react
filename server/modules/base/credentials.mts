import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSystemSql, sql, type SqlQuery } from '@server/database/sql.mjs';
import { createStoredPassword, readStoredPassword, verifyStoredPassword, type StoredPassword } from './auth/index.mjs';

/**
 * 本站账号的登录凭证，与账号资料分表。
 *
 * **没有行就是没有本地密码**——OIDC 建出来的账号就是这种状态，不再需要 '!oidc'
 * 这类哨兵值，也不用拿字符串比较去判断「这是不是占位号」。
 */
export const readCredential = async (database: DatabaseAdapter, userId: string | number | bigint) => {
	const row = await firstSql<{ password: unknown }>(database, sql({ database }).select({
		table: 'base_user_credentials', columns: { password: 'password' },
		where: [{ column: 'user_id', value: userId }], limit: 1,
	}));
	return row ? readStoredPassword(row.password) : undefined;
};

/** 账号有没有本地密码；撞名绑定要用它区分「占位号」与「真实本地账号」。 */
export const hasCredential = async (database: DatabaseAdapter, userId: string | number | bigint) =>
	Boolean(await firstSql(database, sql({ database }).select({
		table: 'base_user_credentials', columns: { id: 'id' },
		where: [{ column: 'user_id', value: userId }], limit: 1,
	})));

export const verifyCredential = async (database: DatabaseAdapter, userId: string | number | bigint, password: string) => {
	const stored = await readCredential(database, userId);
	return stored ? verifyStoredPassword(password, stored) : false;
};

/** 生成写入语句，由调用方决定走 runSystemSql（建号收尾）还是 runOperation（人工改密码）。 */
export const credentialStatement = async (database: DatabaseAdapter, userId: string | number | bigint, password: string | StoredPassword): Promise<SqlQuery> => {
	const stored = typeof password === 'string' ? await createStoredPassword(password) : password;
	return sql({ database }).upsert('base_user_credentials', ['user_id'], { user_id: userId, password: stored }, ['password', 'updated_at']);
};

/** 建号收尾用：不是人做的修改，不留痕。 */
export const setCredential = async (database: DatabaseAdapter, userId: string | number | bigint, password: string | StoredPassword) =>
	runSystemSql(database, await credentialStatement(database, userId, password));
