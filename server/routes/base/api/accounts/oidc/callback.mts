import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { clearAccountsLoginCookie, accountsLoginCookieName, loadAccountsOidcConfig, loadDiscovery, oidcFetch, verifyIdToken } from '@server/modules/passport/accounts/client.mjs';
import { readCookie } from '@server/modules/passport/accounts/oidc.mjs';
import { isValidAccountUsername } from '@server/modules/passport/account.mjs';
import { baseSessionMaxAge, createSessionCookie, hashSessionToken } from '@server/modules/base/auth/index.mjs';
import { ensureBaseDevice } from '@server/modules/base/device.mjs';
import { hasCredential, setCredential } from '@server/modules/base/credentials.mjs';
import { profileStatement, readProfileNickname } from '@server/modules/base/profile.mjs';
import { readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { CREDENTIAL_CLAIM } from '@shared/types/oidc-claims.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { isSecureRequest, requestOrigin } from '@server/modules/base/request-origin.mjs';
import { parseRoles } from '@shared/types/role.mjs';
import type { ApiContext } from '@shared/types/api-response.mjs';

type LoginRequest = { id: string; issuer: string; state: string; nonce: string; code_verifier: string; return_path: string; expires_at: number };

/** 弹窗通知打开方；手机直达时没有 opener，直接跳回发起页。 */
const popupClosePage = (returnPath: string, context?: ApiContext) => {
	const target = JSON.stringify(returnPath || '/').replaceAll('<', '\\u003c');
	const contextValue = JSON.stringify(context ?? null).replaceAll('<', '\\u003c');
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录成功</title><style>body{font-family:system-ui;padding:48px;text-align:center;background:#405a75;color:#f2f7fb}p{color:#d8e5f0}</style></head>`
		+ `<body><h2>登录成功</h2><p>正在返回原页面…</p><script>if(window.opener){window.opener.postMessage({source:'passport',status:'success',next:{action:'navigate',path:${target},refreshAuth:true},context:${contextValue}},window.location.origin);setTimeout(function(){window.close();},100);}else{location.href=${target};}</script></body></html>`;
};

/** 未设置 Accounts 用户名时的本站占位用户名，带下划线，永远不会与合法用户名冲突。 */
const placeholderUsername = (subject: string) => `passport_${subject}`;
const generatedUsername = (username: string) => username.startsWith('passport_') || username.startsWith('accounts_');

/** Accounts 设置用户名后同步改写本站占位用户名；管理员手工改过的名字不覆盖。 */
const syncLocalUsername = async (database: Parameters<typeof runSql>[0], userId: number, username: string, tenantId: string | null) => {
	const current = await firstSql<{ username: string }>(database, sql({ database: database }).select({ table: 'base_users', columns: { username: 'name' }, where: [{ column: 'id', value: userId }] }));
	if (!current || current.username === username || !generatedUsername(current.username)) return;
	// 用户名租户内唯一，占用检查同样限本租户。
	const taken = await firstSql(database, sql({ database: database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: username }, tenantId === null ? { column: 'owner_tid', operator: 'IS NULL' as const } : { column: 'owner_tid', value: tenantId }] }));
	if (taken) return;
	await runSql(database, sql({ database: database }).update('base_users', { name: username }, { id: userId }));
};

/**
 * Accounts 昵称同步到本站资料。
 *
 * 和用户名同步是**两套规则**，别照抄：
 * - 用户名是标识，登录用，租户内唯一、字符集窄；「还没被本站定过」的信号是名字仍是占位名。
 * - 昵称是显示名，不参与登录，字符集宽；「还没被本站定过」的信号是**本站昵称为空**
 *   （没有资料行，或有行但 nickname 为 NULL——用户填了联系方式却没填昵称）。
 *
 * 只在本站昵称为空时补上，人工设过的一律不覆盖。撞名（撞别人的昵称或用户名）就跳过，
 * 显示层自会回落到用户名——登录不该因为一个显示名失败。
 */
const syncLocalNickname = async (database: Parameters<typeof runSql>[0], userId: number, nickname: string, tenantScope: { column: string; value?: unknown; operator?: 'IS NULL' }) => {
	if (await readProfileNickname(database, userId)) return;
	const result = await profileStatement(database, userId, { nickname }, tenantScope);
	if ('statement' in result) await runSql(database, result.statement);
};

const handler: ApiHandler = async (c) => {
	if (c.req.method !== 'GET') return apiMessage(c, 405, '只允许 GET 请求');
	const database = c.get('database'), config = await loadAccountsOidcConfig(c);
	// OIDC 回调整个发生在本站会话建立之前，所有读写都要走系统上下文，否则被自身判定挡住。
	const systemDatabase = c.get('systemDatabase');
	if (!config.enabled) return apiMessage(c, 404, '本站未启用 Accounts OIDC 登录');
	const requestId = readCookie(c.req.raw, accountsLoginCookieName), state = c.req.query('state') ?? '', code = c.req.query('code') ?? '';
	const requestColumns = { id: 'request_id', issuer: 'issuer', state: 'state', nonce: 'nonce', code_verifier: 'code_verifier', return_path: 'return_path', expires_at: 'expires_at' } as const;
	const request = requestId
		? await firstSql<LoginRequest>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_oidc_login_requests', columns: requestColumns, where: [{ column: 'request_id', value: requestId }] }))
		: state ? await firstSql<LoginRequest>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_oidc_login_requests', columns: requestColumns, where: [{ column: 'state', value: state }] })) : undefined;
	if (!request || request.expires_at <= Date.now() || request.issuer !== config.issuer || !state || state !== request.state || !code) return apiMessage(c, 400, 'Accounts 登录回调状态无效或已过期');
	try {
		const discovery = await loadDiscovery(c, config.issuer), callback = `${requestOrigin(c)}/api/accounts/oidc/callback`;
		const tokenResponse = await oidcFetch(c, discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: request.code_verifier }) });
		if (!tokenResponse.ok) throw new Error(`Accounts Token 请求失败（HTTP ${tokenResponse.status}）`);
		const tokens = await tokenResponse.json() as { id_token?: string };
		if (!tokens.id_token) throw new Error('Accounts 未返回 ID Token');
		const jwksResponse = await oidcFetch(c, discovery.jwks_uri); if (!jwksResponse.ok) throw new Error('Accounts 公钥请求失败');
		const claims = await verifyIdToken(tokens.id_token, await jwksResponse.json() as { keys?: JsonWebKey[] }, { issuer: config.issuer, audience: config.clientId, nonce: request.nonce });
		// 凭证 claim 单独取出来，**绝不能混进 profile**：那一列在「数据管理」里是可见的
		// 普通列，写进去等于又泄一处。取出后从 claims 里删掉，后面所有用到 claims 的地方都安全。
		const credentialClaim = claims[CREDENTIAL_CLAIM];
		delete claims[CREDENTIAL_CLAIM];
		const subject = String(claims.sub), now = Date.now();
		const oidcSessionId = String(claims.sid ?? ''); if (!oidcSessionId) throw new Error('ID Token 缺少 sid');
		// 同一个 Accounts 身份在每个租户各有一个本地账号，映射查找必须带上当前租户。
		const tenantId = c.get('tenantId');
		const tenantScope = (column: string) => tenantId === null ? { column, operator: 'IS NULL' as const } : { column, value: tenantId };
		let account = await firstSql<{ user_id: number; status: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_oidc_users', alias: 'a', columns: { user_id: 'a.user_id', status: 'u.status' }, joins: [{ table: 'base_users', alias: 'u', left: 'u.id', right: 'a.user_id' }], where: [{ column: 'a.issuer', value: config.issuer }, { column: 'a.subject', value: subject }, tenantScope('a.owner_tid')] }));
		const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
		if (!account) {
			// 先用占位用户名建号，再按 Accounts 用户名改写，避免撞上本站已有的同名账号。
			const username = placeholderUsername(subject);
			await runSql(systemDatabase, sql({ database: systemDatabase }).ignoreInsert('base_users', ['name', 'owner_tid'], { name: username, roles: [], status: 'enabled' }));
			const user = await firstSql<{ id: number; status: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_users', columns: { id: 'id', status: 'status' }, where: [{ column: 'name', value: username }, tenantScope('owner_tid')] }));
			if (!user) throw new Error('无法创建本站 Accounts 用户');
			// 凭证分表之后，「有没有本地密码」就是「有没有凭证行」——不用再拿 '!oidc' 当哨兵。
			if (await hasCredential(systemDatabase, user.id)) throw new Error('本站已存在同名用户，无法绑定 Accounts 身份');
			// 账号行归属账号自己。
			await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_users', { owner_uid: user.id }, { id: user.id }));
			// 身份绑定归属账号本人；OIDC 回调没有本站会话，不显式绑定则 owner_uid 为 NULL。
			const ownedUser = withDatabaseActors(systemDatabase, { baseUserId: user.id });
			await runSql(ownedUser, sql({ database: ownedUser }).insert('base_oidc_users', { issuer: config.issuer, subject, user_id: user.id, profile: JSON.stringify(claims) }));
			account = { user_id: user.id, status: user.status };
		} else {
			await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_oidc_users', { profile: JSON.stringify(claims) }, [{ column: 'issuer', value: config.issuer }, { column: 'subject', value: subject }, tenantScope('owner_tid')]));
		}
		if (isValidAccountUsername(preferred)) await syncLocalUsername(systemDatabase, account.user_id, preferred, tenantId);
		// name 只在 Accounts 那边**真设过昵称**时才下发；没设就没这个 claim，本站保持回落到用户名。
		const remoteNickname = typeof claims.name === 'string' ? claims.name.trim() : '';
		if (remoteNickname) await syncLocalNickname(systemDatabase, account.user_id, remoteNickname, tenantScope('owner_tid'));
		// 密码同步：两侧都要开。Accounts 那边给这个客户端打开「下发密码」才会带上 claim，
		// 本站再打开「同步 Accounts 密码」才会写入。单向——本站改了密码，下次登录会被覆盖回去。
		if (c.get('siteSettings').passwordSyncEnabled && readStoredPassword(credentialClaim)) {
			await setCredential(systemDatabase, account.user_id, readStoredPassword(credentialClaim)!);
		}
		if (account.status !== 'enabled') return apiMessage(c, 403, '本站用户已停用');
		const maxAge = baseSessionMaxAge;
		const previousSession = await firstSql<{ session_id: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_oidc_sessions', columns: { session_id: 'session_id' }, where: [{ column: 'issuer', value: config.issuer }, { column: 'sid', value: oidcSessionId }] }));
		const sessionToken = crypto.randomUUID(), sessionHash = await hashSessionToken(sessionToken);
		const deviceId = await ensureBaseDevice(systemDatabase, String(account.user_id), c.req.raw, c.get('clientIp'), c.get('transportIp'));
		// 会话与 OIDC 会话映射同样归属账号本人。
		const owned = withDatabaseActors(systemDatabase, { baseUserId: account.user_id });
		let sessionId: string;
		if (previousSession) {
			sessionId = previousSession.session_id;
			await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_sessions', { token_hash: sessionHash, user_id: account.user_id, device_id: deviceId, expires_at: now + maxAge * 1000 }, { id: sessionId }));
		} else {
			await runSql(owned, sql({ database: owned }).insert('base_sessions', { token_hash: sessionHash, user_id: account.user_id, device_id: deviceId, expires_at: now + maxAge * 1000 }));
			const created = await firstSql<{ id: number | string | bigint }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_sessions', columns: { id: 'id' }, where: [{ column: 'token_hash', value: sessionHash }], limit: 1 }));
			if (!created) throw new Error('本站会话创建失败');
			sessionId = String(created.id);
		}
		await runSql(owned, sql({ database: owned }).upsert('base_oidc_sessions', ['issuer', 'sid'], { issuer: config.issuer, sid: oidcSessionId, session_id: sessionId }, ['session_id', 'updated_at']));
		await runSql(systemDatabase, sql({ database: systemDatabase }).delete('base_oidc_login_requests', { request_id: request.id }));
		const secure = isSecureRequest(c);
		c.header('Set-Cookie', clearAccountsLoginCookie(secure)); c.header('Set-Cookie', createSessionCookie(sessionToken, secure, maxAge), { append: true });
		const localUser = await firstSql<{ id: number; username: string; roles: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_users', columns: { id: 'id', username: 'name', roles: 'roles' }, where: [{ column: 'id', value: account.user_id }] }));
		if (localUser) c.set('currentUser', { id: localUser.id, username: localUser.username, roles: parseRoles(localUser.roles) });
		const context = await c.get('apiContext')?.(request.return_path);
		// 登录只在弹窗里完成：直接返回关闭窗口的页面，不再中转到额外的回调页面。
		return c.html(popupClosePage(request.return_path, context));
	} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Accounts 登录回调失败'); }
};
export default handler;
