import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, sql, type SqlQuery } from '@server/database/sql.mjs';

export const maxNicknameLength = 32;
/**
 * 昵称的字符集比用户名宽得多：中文、字母、数字都行。
 * 挡掉的是控制字符——它们看不见，却能造出两个"看起来一样"的昵称。首尾空白先 trim。
 */
const nicknamePattern = /^[^\p{C}]+$/u;

/**
 * 本站账号的资料，与账号本体分表。
 *
 * **没有行就是没设过资料**，昵称回落到用户名。这样建号时不必把用户名抄一份进昵称列
 * ——抄过去还会撞上别人挑走的昵称，那时候要么让建号失败（为便利功能挡住合法注册），
 * 要么悄悄放弃默认值（用户看到昵称是空的，不知道为什么）。回落没有这个两难。
 */
export const nicknameOf = (username: string, nickname?: string | null) => nickname?.trim() || username;

export const readProfileNickname = async (database: DatabaseAdapter, userId: string | number | bigint) => {
	const row = await firstSql<{ nickname: string }>(database, sql({ database }).select({
		table: 'base_user_profiles', columns: { nickname: 'nickname' },
		where: [{ column: 'user_id', value: userId }], limit: 1,
	}));
	return row?.nickname ?? undefined;
};

export type NicknameCheck = { error: string } | { statement: SqlQuery } | { clear: SqlQuery };

/**
 * 校验并生成昵称写入语句。
 *
 * 除了资料表自身的唯一索引，还要挡住「把别人的用户名占成自己的昵称」：昵称在没设时
 * 回落到用户名，不查这一条的话，A 把昵称设成 B 的用户名，两个人显示出来就一模一样。
 */
export const nicknameStatement = async (
	database: DatabaseAdapter,
	userId: string | number | bigint,
	rawNickname: string,
	tenantScope: { column: string; value?: unknown; operator?: 'IS NULL' },
): Promise<NicknameCheck> => {
	const nickname = rawNickname.trim();
	if (!nickname) return { clear: sql({ database }).softDelete('base_user_profiles', { user_id: userId }) };
	if (nickname.length > maxNicknameLength) return { error: `昵称最长 ${maxNicknameLength} 个字符` };
	if (!nicknamePattern.test(nickname)) return { error: '昵称不能包含控制字符' };
	const takenAsUsername = await firstSql(database, sql({ database }).select({
		table: 'base_users', columns: { id: 'id' },
		where: [{ column: 'name', value: nickname }, { column: 'id', operator: '!=', value: userId }, tenantScope], limit: 1,
	}));
	if (takenAsUsername) return { error: '该昵称与其他账号的用户名相同，请更换' };
	return { statement: sql({ database }).upsert('base_user_profiles', ['user_id'], { user_id: userId, nickname }, ['nickname', 'updated_at']) };
};
