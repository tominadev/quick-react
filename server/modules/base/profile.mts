import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, sql, type SqlQuery } from '@server/database/sql.mjs';
import { nicknameError } from '@shared/account-name.mjs';

/**
 * 本站账号的资料，与账号本体分表。
 *
 * **没有行就是没设过资料**，昵称回落到用户名。这样建号时不必把用户名抄一份进昵称列
 * ——抄过去还会撞上别人挑走的昵称，那时候要么让建号失败（为便利功能挡住合法注册），
 * 要么悄悄放弃默认值（用户看到昵称是空的，不知道为什么）。回落没有这个两难。
 */
export const profileNicknameOf = (userName: string, profileNickname?: string | null) => profileNickname?.trim() || userName;

export const readProfileNickname = async (database: DatabaseAdapter, userId: string | number | bigint) => {
	const row = await firstSql<{ profile_nickname: string }>(database, sql({ database }).select({
		table: 'base_user_profiles', columns: { profile_nickname: 'nickname' },
		where: [{ column: 'user_id', value: userId }], limit: 1,
	}));
	return row?.profile_nickname ?? undefined;
};

export type ProfileFields = { profile_nickname?: string; profile_qq?: string; profile_wechat?: string; profile_email?: string };
export type ProfileCheck = { error: string } | { statement: SqlQuery } | { clear: SqlQuery };

/**
 * 校验并生成昵称写入语句。
 *
 * 除了资料表自身的唯一索引，还要挡住「把别人的用户名占成自己的昵称」：昵称在没设时
 * 回落到用户名，不查这一条的话，A 把昵称设成 B 的用户名，两个人显示出来就一模一样。
 */
export const profileStatement = async (
	database: DatabaseAdapter,
	userId: string | number | bigint,
	fields: ProfileFields,
	tenantScope: { column: string; value?: unknown; operator?: 'IS NULL' },
): Promise<ProfileCheck> => {
	const values: Record<string, string> = Object.fromEntries(Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => [key, String(value).trim()]));
	if (!Object.keys(values).length) return { clear: sql({ database }).softDelete('base_user_profiles', { user_id: userId }) };
	const nickname = values.profile_nickname;
	if (nickname !== undefined && nickname) {
		// 字符集与长度规则和 passport 共用一份：昵称按半角宽度计长，全角记 2。
		const error = nicknameError(nickname);
		if (error) return { error };
		// 昵称没设时回落到用户名，所以不能占用别的账号的用户名——否则两个账号显示成同一个名字。
		// 跨表的约束数据库管不了，只能写入前查。
		const takenAsUsername = await firstSql(database, sql({ database }).select({
			table: 'base_users', columns: { id: 'id' },
			where: [{ column: 'name', value: nickname }, { column: 'id', operator: '!=', value: userId }, tenantScope], limit: 1,
		}));
		if (takenAsUsername) return { error: '该昵称与其他账号的用户名相同，请更换' };
		// 昵称租户内唯一。资料表的唯一索引兜底，但那是一条数据库原始报错；登录回调那边更是
		// 一撞就整个登录失败。写入前查一次，撞了给得出话来的消息。
		const takenAsNickname = await firstSql(database, sql({ database }).select({
			table: 'base_user_profiles', columns: { user_id: 'user_id' },
			where: [{ column: 'nickname', value: nickname }, { column: 'user_id', operator: '!=', value: userId }, tenantScope], limit: 1,
		}));
		if (takenAsNickname) return { error: '该昵称已被其他账号使用，请更换' };
	}
	// 昵称清空写 NULL 而不是空串：唯一索引里空串互相相等，第二个不设昵称的账号就建不出来。
	// 也不删整行——只清昵称不该把联系方式一起带走，而留一行全空的资料是无害的。
	// 对外字段带 profile_ 前缀，数据库列不带——两边的映射只在这一处。
	const writable: Record<string, unknown> = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/^profile_/, ''), value]));
	// 昵称清空写 NULL，其余列空串就是空串。
	if (values.profile_nickname === '') writable.nickname = null;
	return { statement: sql({ database }).upsert('base_user_profiles', ['user_id'], { user_id: userId, ...writable }, [...Object.keys(writable), 'updated_at']) };
};
