import type { DatabaseAdapter } from '@server/database/index.mjs';
import { sql, type SqlQuery } from '@server/database/sql.mjs';

/**
 * Accounts 账号的资料，与账号本体分表。
 *
 * 没有行就是没设过昵称，显示时回落到用户名——和 base_user_profiles 同一个套路，
 * 建号时因此不必把占位用户名抄一份进昵称列。
 *
 * 不同的是**这里的昵称不唯一**：本站昵称是人自己挑的，而 Accounts 的昵称来自外部
 * 提供方，没有昵称的微信用户一律叫「微信用户」。加唯一约束会让第二个这样的用户登不进来。
 */
export const passportNicknameOf = (username: string, nickname?: string | null) => nickname?.trim() || username;

export type PassportProfileFields = { nickname?: string; qq?: string; wechat?: string };

/**
 * 生成资料写入语句。昵称清空且没有别的字段时删掉整行——回落到用户名。
 *
 * 联系方式（QQ、微信号）不校验格式也不唯一：它们是给人看的，不是登录凭据。
 * 注意「微信号」是联系方式，与「微信登录绑定」（passport_external_identities）
 * 不是一回事——后者是身份。
 */
export const passportProfileStatement = (database: DatabaseAdapter, userId: string | number | bigint, fields: PassportProfileFields): SqlQuery => {
	const values = Object.fromEntries(Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => [key, String(value).trim()]));
	const clearing = values.nickname === '' && Object.values(values).every((value) => value === '');
	return clearing
		? sql({ database }).softDelete('passport_user_profiles', { user_id: userId })
		: sql({ database }).upsert('passport_user_profiles', ['user_id'], { user_id: userId, ...values }, [...Object.keys(values), 'updated_at']);
};

/** 建号时与 passport_users 一起写入的语句，交给同一个 batch 执行。 */
export const passportProfileInsert = (database: DatabaseAdapter, userId: string | number | bigint, nickname: string): SqlQuery[] =>
	nickname.trim() ? [sql({ database }).insert('passport_user_profiles', { user_id: userId, nickname: nickname.trim() })] : [];
