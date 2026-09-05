import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { baseSessionMaxAge, createSessionCookie, hashSessionToken } from './auth/index.mjs';
import { ensureBaseDevice } from './device.mjs';
import { isSecureRequest } from './request-origin.mjs';
import { profileNicknameOf, profileStatement, readProfileNickname } from './profile.mjs';
import { parseRoles } from '@shared/types/role.mjs';

export type TenantScope = { column: string; value?: unknown; operator?: 'IS NULL' };

/**
 * Accounts 昵称同步到本站资料。
 *
 * 和用户名同步是**两套规则**，别照抄：
 * - 用户名是标识，登录用，租户内唯一、字符集窄；「还没被本站定过」的信号是名字仍是占位名。
 * - 昵称是显示名，不参与登录，字符集宽；「还没被本站定过」的信号是**本站昵称为空**。
 *
 * 只在本站昵称为空时补上，人工设过的一律不覆盖。撞名就跳过，显示层自会回落到用户名——
 * 登录不该因为一个显示名失败。
 */
const syncLocalProfileNickname = async (database: DatabaseAdapter, userId: number, profileNickname: string, scope: TenantScope) => {
	if (await readProfileNickname(database, userId)) return;
	const result = await profileStatement(database, userId, { profile_nickname: profileNickname }, scope);
	if ('statement' in result) await runSql(database, result.statement);
};

/**
 * 把 Accounts 带过来的昵称同步到本站资料。
 *
 * **用户名不同步。** 本站账号的用户名要么是用户在选择页上自己定的，要么是他绑定过去的
 * 已有账号的名字——两种都是人挑的，Accounts 那边改名不该跟着改。（占位用户名
 * `passport_<sub>` 那套连同它的改名逻辑随选择页一起废弃了：现在建号必定有个真名字。）
 */
export const syncAccountsIdentity = async (c: Context<AppEnv>, database: DatabaseAdapter, userId: number, claims: Record<string, unknown>, scope: TenantScope) => {
	// name 只在 Accounts 那边**真设过昵称**时才下发；没设就没这个 claim，本站保持回落到用户名。
	const remote = typeof claims.name === 'string' ? claims.name.trim() : '';
	if (remote) await syncLocalProfileNickname(database, userId, remote, scope);
};

/**
 * 建立本站会话并写好 Cookie。回调与绑定页共用——两条路走到这里时，
 * 「这个 Accounts 身份属于哪个本站账号」都已经定下来了。
 */
export const createAccountsSession = async (c: Context<AppEnv>, database: DatabaseAdapter, userId: number, issuer: string, oidcSessionId: string) => {
	const now = Date.now(), maxAge = baseSessionMaxAge;
	const previous = await firstSql<{ session_id: string }>(database, sql({ database }).select({ table: 'base_oidc_sessions', columns: { session_id: 'session_id' }, where: [{ column: 'issuer', value: issuer }, { column: 'sid', value: oidcSessionId }] }));
	const sessionToken = crypto.randomUUID(), sessionHash = await hashSessionToken(sessionToken);
	const deviceId = await ensureBaseDevice(database, String(userId), c.req.raw, c.get('clientIp'), c.get('transportIp'));
	// 会话与 OIDC 会话映射同样归属账号本人。
	const owned = withDatabaseActors(database, { baseUserId: userId });
	let sessionId: string;
	if (previous) {
		sessionId = previous.session_id;
		await runSql(database, sql({ database }).update('base_sessions', { token_hash: sessionHash, user_id: userId, device_id: deviceId, expires_at: now + maxAge * 1000 }, { id: sessionId }));
	} else {
		await runSql(owned, sql({ database: owned }).insert('base_sessions', { token_hash: sessionHash, user_id: userId, device_id: deviceId, expires_at: now + maxAge * 1000 }));
		const created = await firstSql<{ id: number | string | bigint }>(database, sql({ database }).select({ table: 'base_sessions', columns: { id: 'id' }, where: [{ column: 'token_hash', value: sessionHash }], limit: 1 }));
		if (!created) throw new Error('本站会话创建失败');
		sessionId = String(created.id);
	}
	await runSql(owned, sql({ database: owned }).upsert('base_oidc_sessions', ['issuer', 'sid'], { issuer, sid: oidcSessionId, session_id: sessionId }, ['session_id', 'updated_at']));
	c.header('Set-Cookie', createSessionCookie(sessionToken, isSecureRequest(c), maxAge), { append: true });
	const localUser = await firstSql<{ id: number; user_name: string; profile_nickname: string | null; roles: string }>(database, sql({ database }).select({
		table: 'base_users', alias: 'u', columns: { id: 'u.id', user_name: 'u.name', profile_nickname: 'p.nickname', roles: 'u.roles' },
		joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }], where: [{ column: 'u.id', value: userId }],
	}));
	if (localUser) c.set('currentUser', { id: localUser.id, user_name: localUser.user_name, profile_nickname: profileNicknameOf(localUser.user_name, localUser.profile_nickname), roles: parseRoles(localUser.roles) });
};
