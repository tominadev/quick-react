import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { validateBaseDevice } from '@server/modules/base/device.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';

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
	const user = await firstSql<{ user_id: string; nickname: string; device_id?: string | null }>(database, sql({ database }).select({ table: 'passport_sessions', alias: 's', columns: { user_id: { column: 'u.user_id', cast: 'text' }, nickname: 'u.nickname', device_id: { column: 's.device_id', cast: 'text' } }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.user_id', right: 's.user_id' }], where: [{ column: 's.token_hash', value: sessionHash }, { column: 's.expires_at', operator: '>', value: Date.now() }, { column: 'u.status', value: 'enabled' }] }));
	if (!user) return undefined;
	if (!user.device_id) {
		await runSql(database, sql({ database }).delete('passport_sessions', { token_hash: sessionHash }));
		return undefined;
	}
	try {
		if (await validateBaseDevice(database, user.user_id, user.device_id, request)) return { id: user.user_id, username: user.nickname, roles: [] };
	} catch {
		// 指纹格式错误同样使当前会话失效。
	}
	await runSql(database, sql({ database }).delete('passport_sessions', { token_hash: sessionHash }));
	return undefined;
};
