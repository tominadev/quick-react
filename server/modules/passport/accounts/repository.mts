import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { loadAccountUserName } from '@server/modules/passport/account.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';

export type OidcClientRecord = { id: string; name: string; secret_hash: string; redirect_uris: string; backchannel_logout_uri: string; allowed_scopes: string; require_pkce: number; strict_redirect_uri: number; password_sync: number; status: string; created_at: number; updated_at: number };
export type AuthorizationRequestRecord = { client_id: string; redirect_uri: string; scope: string; state: string; nonce: string; code_challenge: string; code_challenge_method: string; expires_at: number };
export type AuthorizationCodeRecord = { client_id: string; user_id: string; redirect_uri: string; scope: string; nonce: string; code_challenge: string; code_challenge_method: string; expires_at: number; consumed_at: number | null; session_id: string };

export const activeSigningKey = (database: DatabaseAdapter) => firstSql<{ kid: string; private_jwk: string; public_jwk: string }>(database, sql({ database }).select({ table: 'passport_oidc_signing_keys', columns: { kid: 'kid', private_jwk: 'private_jwk', public_jwk: 'public_jwk' }, where: [{ column: 'status', value: 'active' }], orderBy: [{ column: 'created_at', direction: 'DESC' }], limit: 1 }));
export const signingPublicKeys = (database: DatabaseAdapter) => Promise.all(['active', 'retired'].map((status) => allSql<{ public_jwk: string }>(database, sql({ database }).select({ table: 'passport_oidc_signing_keys', columns: { public_jwk: 'public_jwk' }, where: [{ column: 'status', value: status }], orderBy: [{ column: 'created_at', direction: 'DESC' }] })))).then((rows) => rows.flat());
const oidcClientColumns = { id: 'client_id', name: 'name', secret_hash: 'secret_hash', redirect_uris: 'redirect_uris', backchannel_logout_uri: 'backchannel_logout_uri', allowed_scopes: 'allowed_scopes', require_pkce: 'require_pkce', strict_redirect_uri: 'strict_redirect_uri', password_sync: 'password_sync', status: 'status', created_at: 'created_at', updated_at: 'updated_at' } as const;
export const oidcClients = (database: DatabaseAdapter) => allSql<OidcClientRecord>(database, sql({ database }).select({ table: 'passport_oidc_clients', columns: oidcClientColumns, orderBy: [{ column: 'created_at', direction: 'DESC' }] }));
export const oidcClient = (database: DatabaseAdapter, id: string) => firstSql<OidcClientRecord>(database, sql({ database }).select({ table: 'passport_oidc_clients', columns: oidcClientColumns, where: [{ column: 'client_id', value: id }] }));
export const authorizationRequest = (database: DatabaseAdapter, id: string) => firstSql<AuthorizationRequestRecord>(database, sql({ database }).select({ table: 'passport_oidc_authorization_requests', columns: { client_id: 'client_id', redirect_uri: 'redirect_uri', scope: 'scope', state: 'state', nonce: 'nonce', code_challenge: 'code_challenge', code_challenge_method: 'code_challenge_method', expires_at: 'expires_at' }, where: [{ column: 'request_id', value: id }] }));
export const authorizationCode = (database: DatabaseAdapter, hash: string) => firstSql<AuthorizationCodeRecord>(database, sql({ database }).select({ table: 'passport_oidc_authorization_codes', columns: { client_id: 'client_id', user_id: { column: 'user_id', cast: 'text' }, redirect_uri: 'redirect_uri', scope: 'scope', nonce: 'nonce', code_challenge: 'code_challenge', code_challenge_method: 'code_challenge_method', expires_at: 'expires_at', consumed_at: 'consumed_at', session_id: 'session_id' }, where: [{ column: 'code_hash', value: hash }] }));

export const accountUser = async (database: DatabaseAdapter, userId: string) => {
	// ID Token 的 name 只在**真有昵称**时下发。
	//
	// 不能在这里回落到用户名：回落是显示层的事，各系统各回各的（passport 回落到 passport
	// 用户名，业务站点回落到本站用户名）。塞进 claim 的话下游分不清「这是昵称」还是
	// 「这人没昵称、拿用户名顶上的」，照着同步就会把 passport 用户名灌进本站昵称——
	// 凭空造出一个「用户设过昵称」的假状态。claim 里只放事实。
	const row = await firstSql<{ sub: string; user_name: string; profile_nickname: string | null; status: string }>(database, sql({ database }).select({
		table: 'passport_users', alias: 'u',
		columns: { sub: { column: 'u.user_id', cast: 'text' }, user_name: 'u.name', profile_nickname: 'p.nickname', status: 'u.status' },
		joins: [{ type: 'LEFT', table: 'passport_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.user_id' }],
		where: [{ column: 'u.user_id', value: userId }],
	}));
	if (!row) return null;
	const profileNickname = row.profile_nickname?.trim() ?? '';
	const user = { sub: row.sub, status: row.status, ...(profileNickname ? { name: profileNickname } : {}) };
	// 用户名是可选能力，只有设置过才作为 preferred_username 下发。
	const userName = await loadAccountUserName(database, userId);
	const email = await firstSql<{ email: string }>(database, sql({ database }).select({ table: 'passport_user_emails', alias: 'ue', columns: { email: 'e.email' }, joins: [{ table: 'passport_emails', alias: 'e', left: 'e.id', right: 'ue.email_id' }], where: [{ column: 'ue.user_id', value: userId }, { column: 'ue.is_primary', value: 1 }, { column: 'e.verified', value: 1 }], limit: 1 }));
	return { ...user, ...(userName ? { preferred_username: userName } : {}), email: email?.email };
};

/**
 * 凭证 blob，只在客户端打开 password_sync 时下发。
 *
 * 送的是哈希不是明文——标准 OIDC 流程里 Accounts 也拿不到明文，用户是在这边的页面上
 * 输的。授权码换 token 是服务端到服务端的，这个 claim 不经过浏览器。
 */
export const accountCredentialClaim = async (database: DatabaseAdapter, userId: string) => {
	const row = await firstSql<{ password: unknown }>(database, sql({ database }).select({
		table: 'passport_user_credentials', columns: { password: 'password' },
		where: [{ column: 'user_id', value: userId }], limit: 1,
	}));
	return row?.password;
};

export const accessTokenUser = async (database: DatabaseAdapter, tokenHash: string, now: number) => {
	const token = await firstSql<{ user_id: string }>(database, sql({ database }).select({ table: 'passport_oidc_access_tokens', alias: 't', columns: { user_id: { column: 't.user_id', cast: 'text' } }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.user_id', right: 't.user_id' }], where: [{ column: 't.token_hash', value: tokenHash }, { column: 't.expires_at', operator: '>', value: now }, { column: 't.revoked_at', operator: 'IS NULL' }, { column: 'u.status', value: 'enabled' }] }));
	return token ? accountUser(database, token.user_id) : null;
};

export const passportSessionUser = async (database: DatabaseAdapter, sessionId: string) => firstSql<{ user_id: string }>(database, sql({ database }).select({ table: 'passport_sessions', columns: { user_id: { column: 'user_id', cast: 'text' } }, where: [{ column: 'token_hash', value: await sha256(sessionId) }] }));
export const backchannelClients = (database: DatabaseAdapter, sessionId: string) => allSql<{ id: string; backchannel_logout_uri: string }>(database, sql({ database }).select({ table: 'passport_oidc_access_tokens', alias: 't', distinct: true, columns: { id: 'c.client_id', backchannel_logout_uri: 'c.backchannel_logout_uri' }, joins: [{ table: 'passport_oidc_clients', alias: 'c', left: 'c.client_id', right: 't.client_id' }], where: [{ column: 't.session_id', value: sessionId }, { column: 't.revoked_at', operator: 'IS NULL' }, { column: 'c.backchannel_logout_uri', operator: '!=', value: '' }] }));
