import { createStoredPassword, hashPassword, verifyPassword, verifyStoredPassword } from '@server/modules/base/auth/index.mjs';
import { clampNickname } from '@shared/account-name.mjs';
import type { DatabaseAdapter, DatabaseBatchStatement } from '@server/database/index.mjs';
import { allSql, firstSql, runSql, sql } from '@server/database/sql.mjs';
import { passportProfileInsert } from '@server/modules/passport/profile.mjs';
import { nextSnowflake } from '@server/modules/base/snowflake.mjs';
import { passportPlaceholderName } from './account.mjs';
import { assertPassword } from '@server/modules/base/auth/password-policy.mjs';

const signed64Min = -(1n << 63n);
const signed64Max = (1n << 63n) - 1n;
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

const decimalId = (value: string | number | bigint, positive: boolean) => {
	const text = String(value).trim();
	if (!/^-?\d+$/.test(text)) throw new Error('Invalid 64-bit identity value');
	const parsed = BigInt(text);
	if (parsed < signed64Min || parsed > signed64Max || (positive && parsed <= 0n)) throw new Error('Invalid 64-bit identity value');
	return parsed.toString();
};

export const normalizePassportEmail = (value: string) => {
	const email = value.trim().toLowerCase();
	if (email.length > 254 || !emailPattern.test(email)) throw new Error('邮箱地址格式不正确');
	return email;
};

export const normalizePassportNickname = (value: string, telegramUserId: string | number | bigint) => {
	// 外部昵称不是用户在本站挑的，太短就拒绝会让人登不进来，所以只截断不报错。
	return clampNickname(value, `TG${decimalId(telegramUserId, true).slice(-10)}`);
};

const generateOtpCode = () => {
	const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
	const values = new Uint32Array(1);
	do crypto.getRandomValues(values); while (values[0] >= limit);
	return String(values[0] % 1_000_000).padStart(6, '0');
};

export class TelegramOtpRateLimitError extends Error {
	constructor(public readonly waitSeconds: number) {
		super(`请 ${waitSeconds} 秒后重试`);
	}
}

export type TelegramIdentity = {
	botId: string | number | bigint;
	telegramUserId: string | number | bigint;
	chatId: string | number | bigint;
	nickname: string;
};

export const issueTelegramEmailOtp = async (database: DatabaseAdapter, identity: TelegramIdentity, rawEmail: string, lifetimeMs = 10 * 60_000) => {
	const botId = decimalId(identity.botId, true);
	const telegramUserId = decimalId(identity.telegramUserId, true);
	const chatId = decimalId(identity.chatId, false);
	const email = normalizePassportEmail(rawEmail);
	const code = generateOtpCode();
	const now = Date.now();
	const recent = await allSql<{ created_at: number }>(database, sql({ database }).select({ table: 'passport_telegram_email_otps', columns: { created_at: 'created_at' }, where: [{ column: 'bot_id', value: botId }, { column: 'telegram_user_id', value: telegramUserId }, { column: 'created_at', operator: '>=', value: now - 60 * 60_000 }], orderBy: [{ column: 'created_at' }] }));
	const firstCreatedAt = recent[0]?.created_at, lastCreatedAt = recent.at(-1)?.created_at;
	if (lastCreatedAt && now - lastCreatedAt < 60_000) throw new TelegramOtpRateLimitError(Math.ceil((60_000 - (now - lastCreatedAt)) / 1000));
	if (recent.length >= 10) throw new TelegramOtpRateLimitError(Math.max(1, Math.ceil((Number(firstCreatedAt ?? now) + 60 * 60_000 - now) / 1000)));
	await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'expired' }, [{ column: 'bot_id', value: botId }, { column: 'telegram_user_id', value: telegramUserId }, { column: 'status', value: 'pending' }]));
	await runSql(database, sql({ database }).insert('passport_telegram_email_otps', { bot_id: botId, telegram_user_id: telegramUserId, chat_id: chatId, email, code_hash: await hashPassword(code), attempt_count: 0, status: 'pending', expires_at: now + lifetimeMs }));
	return { code, email, expiresAt: now + lifetimeMs };
};

export const expireTelegramEmailOtp = async (database: DatabaseAdapter, identity: TelegramIdentity) => {
	const botId = decimalId(identity.botId, true), telegramUserId = decimalId(identity.telegramUserId, true);
	await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'expired' }, [{ column: 'bot_id', value: botId }, { column: 'telegram_user_id', value: telegramUserId }, { column: 'status', value: 'pending' }]));
};

type AccountOwner = { user_key: string; status: string };

const telegramOwner = (database: DatabaseAdapter, botId: string, telegramUserId: string) => firstSql<AccountOwner>(database, sql({ database }).select({ table: 'passport_telegram_accounts', alias: 'a', columns: { user_key: { column: 'a.user_key', cast: 'text' }, status: 'u.status' }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.key', right: 'a.user_key' }], where: [{ column: 'a.bot_id', value: botId }, { column: 'a.telegram_user_id', value: telegramUserId }] }));

const emailOwner = (database: DatabaseAdapter, email: string) => firstSql<AccountOwner>(database, sql({ database }).select({ table: 'passport_emails', alias: 'e', columns: { user_key: { column: 'ue.user_key', cast: 'text' }, status: 'u.status' }, joins: [{ table: 'passport_user_emails', alias: 'ue', left: 'ue.email_id', right: 'e.id' }, { table: 'passport_users', alias: 'u', left: 'u.key', right: 'ue.user_key' }], where: [{ column: 'e.email', value: email }] }));

export type TelegramOtpVerification =
	| { status: 'created' | 'linked' | 'existing'; userId: string }
	| { status: 'conflict'; telegramUserId?: string; emailUserId?: string }
	| { status: 'disabled'; userId: string }
	| { status: 'invalid' | 'expired' | 'locked' };

export const verifyTelegramEmailOtp = async (
	database: DatabaseAdapter,
	identity: TelegramIdentity,
	rawCode: string,
): Promise<TelegramOtpVerification> => {
	const botId = decimalId(identity.botId, true);
	const telegramUserId = decimalId(identity.telegramUserId, true);
	const chatId = decimalId(identity.chatId, false);
	const code = rawCode.trim();
	if (!/^\d{6}$/.test(code)) return { status: 'invalid' };
	const otp = await firstSql<{
		id: number; email: string; code_hash: string; attempt_count: number; expires_at: number;
	}>(database, sql({ database }).select({ table: 'passport_telegram_email_otps', columns: { id: 'id', email: 'email', code_hash: 'code_hash', attempt_count: 'attempt_count', expires_at: 'expires_at' }, where: [{ column: 'bot_id', value: botId }, { column: 'telegram_user_id', value: telegramUserId }, { column: 'status', value: 'pending' }], orderBy: [{ column: 'created_at', direction: 'DESC' }, { column: 'id', direction: 'DESC' }], limit: 1 }));
	if (!otp) return { status: 'invalid' };
	if (otp.expires_at <= Date.now()) {
		await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'expired' }, { id: otp.id, status: 'pending' }));
		return { status: 'expired' };
	}
	if (otp.attempt_count >= 5) {
		await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'expired' }, { id: otp.id, status: 'pending' }));
		return { status: 'locked' };
	}
	if (!await verifyPassword(code, otp.code_hash)) {
		const nextAttempts = otp.attempt_count + 1;
		await runSql(database, sql({ database }).update('passport_telegram_email_otps', { attempt_count: nextAttempts, status: nextAttempts >= 5 ? 'expired' : 'pending' }, { id: otp.id, status: 'pending' }));
		return { status: nextAttempts >= 5 ? 'locked' : 'invalid' };
	}

	const [external, email] = await Promise.all([
		telegramOwner(database, botId, telegramUserId),
		emailOwner(database, otp.email),
	]);
	if (external?.status === 'disabled') return { status: 'disabled', userId: external.user_key };
	if (email?.status === 'disabled') return { status: 'disabled', userId: email.user_key };
	if (external && email && external.user_key !== email.user_key) {
		await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'used' }, { id: otp.id, status: 'pending' }));
		return { status: 'conflict', telegramUserId: external.user_key, emailUserId: email.user_key };
	}
	if (!external && email) {
		await runSql(database, sql({ database }).update('passport_telegram_email_otps', { status: 'used' }, { id: otp.id, status: 'pending' }));
		return { status: 'conflict', emailUserId: email.user_key };
	}

	const now = Date.now();
	const nickname = normalizePassportNickname(identity.nickname, telegramUserId);
		const builder = sql({ database });
	const statements: DatabaseBatchStatement[] = [];
	let userId: string;
	let resultStatus: 'created' | 'linked' | 'existing';
	if (external) {
		userId = external.user_key;
		resultStatus = email ? 'existing' : 'linked';
		statements.push(builder.update('passport_telegram_accounts', { chat_id: chatId, nickname }, { bot_id: botId, telegram_user_id: telegramUserId }));
	} else {
		userId = nextSnowflake();
		const accountId = nextSnowflake();
		resultStatus = 'created';
		statements.push(
			builder.insert('passport_users', { key: userId, name: passportPlaceholderName(userId), status: 'enabled' }),
			...passportProfileInsert(database, userId, nickname),
			builder.insert('passport_telegram_accounts', { id: accountId, user_key: userId, bot_id: botId, telegram_user_id: telegramUserId, chat_id: chatId, nickname }),
		);
	}
	if (!email) {
		const emailId = nextSnowflake();
		const hasUserEmail = Boolean(await firstSql(database, builder.select({ table: 'passport_user_emails', columns: { email_id: { column: 'email_id', cast: 'text' } }, where: [{ column: 'user_key', value: userId }], limit: 1 })));
		statements.push(
			builder.insert('passport_emails', { id: emailId, email: otp.email, verified: 1 }),
			builder.insert('passport_user_emails', { user_key: userId, email_id: emailId, is_primary: hasUserEmail ? 0 : 1 }),
		);
	}
	statements.push(builder.update('passport_telegram_email_otps', { status: 'used' }, { id: otp.id, status: 'pending' }));
	if (!database.batch) throw new Error('Passport database does not support atomic batch writes');
	await database.batch(statements);
	return { status: resultStatus, userId };
};

export const createTelegramIdentityChoice = async (
	database: DatabaseAdapter,
	identity: TelegramIdentity,
	targetUserIdValue: string | number | bigint,
	rawEmail: string,
	lifetimeMs = 10 * 60_000,
) => {
	const botId = decimalId(identity.botId, true), telegramUserId = decimalId(identity.telegramUserId, true), chatId = decimalId(identity.chatId, false);
	const targetUserId = decimalId(targetUserIdValue, true), email = normalizePassportEmail(rawEmail), now = Date.now();
	const owner = await emailOwner(database, email);
	if (!owner || owner.user_key !== targetUserId || owner.status !== 'enabled') throw new Error('目标账户或邮箱状态已变化');
	await runSql(database, sql({ database }).update('passport_telegram_identity_choices', { status: 'cancelled' }, { bot_id: botId, telegram_user_id: telegramUserId, status: 'pending' }));
	await runSql(database, sql({ database }).insert('passport_telegram_identity_choices', { bot_id: botId, telegram_user_id: telegramUserId, chat_id: chatId, target_user_key: targetUserId, email, status: 'pending', expires_at: now + lifetimeMs }));
	const choice = await firstSql<{ id: number }>(database, sql({ database }).select({ table: 'passport_telegram_identity_choices', columns: { id: 'id' }, where: [{ column: 'bot_id', value: botId }, { column: 'telegram_user_id', value: telegramUserId }, { column: 'status', value: 'pending' }], orderBy: [{ column: 'created_at', direction: 'DESC' }, { column: 'id', direction: 'DESC' }], limit: 1 }));
	if (!choice) throw new Error('账户选择创建后无法读取');
	return { id: String(choice.id), targetUserId, email, expiresAt: now + lifetimeMs };
};

export const confirmTelegramIdentityChoice = async (
	database: DatabaseAdapter,
	identity: TelegramIdentity,
	choiceIdValue: string | number | bigint,
) => {
	const botId = decimalId(identity.botId, true), telegramUserId = decimalId(identity.telegramUserId, true), chatId = decimalId(identity.chatId, false);
	const choiceId = decimalId(choiceIdValue, true);
	const choice = await firstSql<{ target_user_key: string; email: string; expires_at: number; status: string }>(database, sql({ database }).select({ table: 'passport_telegram_identity_choices', alias: 'c', columns: { target_user_key: { column: 'c.target_user_key', cast: 'text' }, email: 'c.email', expires_at: 'c.expires_at', status: 'u.status' }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.key', right: 'c.target_user_key' }], where: [{ column: 'c.id', value: choiceId }, { column: 'c.bot_id', value: botId }, { column: 'c.telegram_user_id', value: telegramUserId }, { column: 'c.status', value: 'pending' }] }));
	if (!choice) return { status: 'invalid' as const };
	if (choice.expires_at <= Date.now()) {
		await runSql(database, sql({ database }).update('passport_telegram_identity_choices', { status: 'expired' }, { id: choiceId, status: 'pending' }));
		return { status: 'expired' as const };
	}
	if (choice.status !== 'enabled') return { status: 'disabled' as const };
	const [external, owner] = await Promise.all([telegramOwner(database, botId, telegramUserId), emailOwner(database, choice.email)]);
	if (!owner || owner.user_key !== choice.target_user_key) return { status: 'conflict' as const };
	if (external) {
		if (external.user_key !== choice.target_user_key) return { status: 'conflict' as const };
		await runSql(database, sql({ database }).update('passport_telegram_identity_choices', { status: 'confirmed' }, { id: choiceId, status: 'pending' }));
		return { status: 'existing' as const, userId: external.user_key };
	}
	const now = Date.now(), accountId = nextSnowflake();
	if (!database.batch) throw new Error('Passport database does not support atomic batch writes');
	const builder = sql({ database });
	await database.batch([
		builder.insert('passport_telegram_accounts', { id: accountId, user_key: choice.target_user_key, bot_id: botId, telegram_user_id: telegramUserId, chat_id: chatId, nickname: normalizePassportNickname(identity.nickname, telegramUserId) }),
		builder.update('passport_telegram_identity_choices', { status: 'confirmed' }, { id: choiceId, status: 'pending' }),
	]);
	return { status: 'linked' as const, userId: choice.target_user_key };
};

export const cancelTelegramIdentityChoice = async (database: DatabaseAdapter, identity: TelegramIdentity, choiceIdValue: string | number | bigint) => {
	const botId = decimalId(identity.botId, true), telegramUserId = decimalId(identity.telegramUserId, true), choiceId = decimalId(choiceIdValue, true);
	await runSql(database, sql({ database }).update('passport_telegram_identity_choices', { status: 'cancelled' }, { id: choiceId, bot_id: botId, telegram_user_id: telegramUserId, status: 'pending' }));
};

export const setPassportPassword = async (database: DatabaseAdapter, userIdValue: string | number | bigint, password: string) => {
	const userId = decimalId(userIdValue, true);
	assertPassword(password);
	const user = await firstSql(database, sql({ database }).select({ table: 'passport_users', columns: { user_key: { column: 'key', cast: 'text' } }, where: [{ column: 'key', value: userId }, { column: 'status', value: 'enabled' }] }));
	if (!user) throw new Error('用户不存在或已停用');
	await runSql(database, sql({ database }).insert('passport_user_credentials', { user_key: userId, password: await createStoredPassword(password) }));
};

export const verifyPassportPasswordHistory = async (database: DatabaseAdapter, userIdValue: string | number | bigint, password: string) => {
	const userId = decimalId(userIdValue, true);
	const credentials = await allSql<{ password: string; created_at: number }>(database, sql({ database }).select({ table: 'passport_user_credentials', columns: { password: 'password', created_at: 'created_at' }, where: [{ column: 'user_key', value: userId }], orderBy: [{ column: 'created_at', direction: 'DESC' }, { column: 'id', direction: 'DESC' }] }));
	for (let index = 0; index < credentials.length; index += 1) {
		if (!await verifyStoredPassword(password, credentials[index].password)) continue;
		return index === 0
			? { status: 'current' as const, createdAt: credentials[index].created_at }
			: { status: 'old' as const, changedAt: credentials[0].created_at };
	}
	return { status: 'invalid' as const };
};
