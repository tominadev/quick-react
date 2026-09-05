import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { passportProfileNicknameOf } from './profile.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';
import { validatePassportDevice } from '@server/modules/passport/device.mjs';

export const passportSessionCookieName = 'passport_session';

const readCookie = (request: Request, name: string) => {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [candidate, ...value] = part.trim().split('=');
		if (candidate === name) return decodeURIComponent(value.join('='));
	}
};

export const readPassportSessionId = (request: Request) => readCookie(request, passportSessionCookieName);
export const createPassportSessionCookie = (sessionId: string, secure: boolean, maxAge: number) =>
	`${passportSessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export const clearPassportSessionCookie = (secure: boolean) =>
	`${passportSessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/**
 * 读取身份中心自身的会话；业务站点通过 OIDC 建立本站会话，不共享这个 Cookie。
 * Accounts 只提供身份，不带任何权限：站点角色一律由站点自己在用户管理里分配。
 */
export const loadPassportSession = async (database: DatabaseAdapter, request: Request) => {
	const sessionId = readPassportSessionId(request);
	if (!sessionId) return undefined;
	const sessionHash = await sha256(sessionId);
	const user = await firstSql<{ user_id: string; user_name: string; profile_nickname: string | null; device_id?: string | null }>(database, sql({ database }).select({ table: 'passport_sessions', alias: 's', columns: { user_id: { column: 'u.user_id', cast: 'text' }, user_name: 'u.name', profile_nickname: 'p.nickname', device_id: { column: 's.device_id', cast: 'text' } }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.user_id', right: 's.user_id' }, { type: 'LEFT' as const, table: 'passport_user_profiles', alias: 'p', left: 'p.user_id', right: 's.user_id' }], where: [{ column: 's.token_hash', value: sessionHash }, { column: 's.expires_at', operator: '>', value: Date.now() }, { column: 'u.status', value: 'enabled' }] }));
	if (!user) return undefined;
	if (!user.device_id) {
		await runSql(database, sql({ database }).delete('passport_sessions', { token_hash: sessionHash }));
		return undefined;
	}
	try {
		if (await validatePassportDevice(database, user.user_id, user.device_id, request)) // 没设过资料就回落到用户名。
			return { id: user.user_id, user_name: user.user_name, profile_nickname: passportProfileNicknameOf(user.user_name, user.profile_nickname), roles: [] };
	} catch {
		// 指纹格式错误同样使当前会话失效。
	}
	await runSql(database, sql({ database }).delete('passport_sessions', { token_hash: sessionHash }));
	return undefined;
};

/** Resolve the Passport device-user binding that owns the current Accounts session. */
export const loadPassportDeviceUserId = async (database: DatabaseAdapter, request: Request): Promise<string | number | bigint | null> => {
	const sessionId = readPassportSessionId(request);
	if (!sessionId) return null;
	const sessionHash = await sha256(sessionId);
	const session = await firstSql<{ user_id: string; device_id: string | null }>(database, sql({ database }).select({
		table: 'passport_sessions',
		columns: { user_id: { column: 'user_id', cast: 'text' }, device_id: { column: 'device_id', cast: 'text' } },
		where: [{ column: 'token_hash', value: sessionHash }, { column: 'expires_at', operator: '>', value: Date.now() }],
		limit: 1,
	}));
	if (!session?.device_id) return null;
	const binding = await firstSql<{ id: string }>(database, sql({ database }).select({
		table: 'passport_device_users',
		columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'device_id', value: session.device_id }, { column: 'user_id', value: session.user_id }, { column: 'status', value: 'active' }],
		limit: 1,
	}));
	return binding?.id ?? null;
};
