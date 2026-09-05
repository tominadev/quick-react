import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { clearAccountsLoginCookie, accountsLoginCookieName, loadAccountsOidcConfig, loadDiscovery, oidcFetch, verifyIdToken } from '@server/modules/passport/accounts/client.mjs';
import { readCookie } from '@server/modules/passport/accounts/oidc.mjs';
import { createAccountsSession } from '@server/modules/base/accounts-link.mjs';
import { readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { CREDENTIAL_CLAIM } from '@shared/types/oidc-claims.mjs';
import { firstSql, runSql, sql, ownerScope } from '@server/database/sql.mjs';
import { isSecureRequest, requestOrigin } from '@server/modules/base/request-origin.mjs';
import type { ApiContext } from '@shared/types/api-response.mjs';

type LoginRequest = { id: string; issuer: string; state: string; nonce: string; code_verifier: string; return_path: string; expires_at: number };

/** 首次用这个 Accounts 身份登录本站时，让主窗口去这个页面选「新建」还是「绑定已有」。 */
const bindPagePath = (c: Parameters<ApiHandler>[0]) => `/accounts/oidc/bind${c.get('techStackConfig').pageSuffix}`;

/** 弹窗通知打开方；手机直达时没有 opener，直接跳回发起页。 */
const popupClosePage = (returnPath: string, context?: ApiContext) => {
	const target = JSON.stringify(returnPath || '/').replaceAll('<', '\\u003c');
	const contextValue = JSON.stringify(context ?? null).replaceAll('<', '\\u003c');
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录成功</title><style>body{font-family:system-ui;padding:48px;text-align:center;background:#405a75;color:#f2f7fb}p{color:#d8e5f0}</style></head>`
		+ `<body><h2>登录成功</h2><p>正在返回原页面…</p><script>if(window.opener){window.opener.postMessage({source:'passport',status:'success',next:{action:'navigate',path:${target},refreshAuth:true},context:${contextValue}},window.location.origin);setTimeout(function(){window.close();},100);}else{location.href=${target};}</script></body></html>`;
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
		const tenantScope = (column: string) => ownerScope(column, tenantId);
		let account = await firstSql<{ user_id: number; status: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_oidc_users', alias: 'a', columns: { user_id: 'a.user_id', status: 'u.status' }, joins: [{ table: 'base_users', alias: 'u', left: 'u.id', right: 'a.user_id' }], where: [{ column: 'a.issuer', value: config.issuer }, { column: 'a.subject', value: subject }, tenantScope('a.owner_tid')] }));
		const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
		if (!account) {
			// 身份验证通过了，但这个 Accounts 身份在本站还没有账号。**这里不建号**：
			// 建号是不可撤销的副作用，而用户此刻还没表态要「新建」还是「绑定到已有账号」。
			// 先建占位号再按选择删掉，在没有事务的环境里意味着中间态会被别的请求看见。
			//
			// 凭证 blob 存在自己那一列，**不混进 claims**——claims 最终会写进
			// base_oidc_users.profile，那是「数据管理」里可见的普通列。credential 那一列
			// 在 HIDDEN_VALUE_COLUMNS 里，且随请求行在落定时一起删掉。
			const credential = c.get('siteSettings').passwordSyncEnabled && readStoredPassword(credentialClaim) ? JSON.stringify(credentialClaim) : '';
			await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_oidc_login_requests', {
				status: 'choosing', subject, claims: JSON.stringify(claims), credential, expires_at: now + 600_000,
			}, { request_id: request.id }));
			// 选择页是主窗口的整页，不是弹窗：关掉弹窗，让打开它的页面跳过去。
			const context = await c.get('apiContext')?.(bindPagePath(c));
			return c.html(popupClosePage(bindPagePath(c), context));
		}
		// 只更新身份档案，**不同步用户名和昵称**：绑定之后两边各管各的，
		// Accounts 那边改名不该跟着改本站账号，反过来也一样。同步只在首次绑定时做一次。
		await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_oidc_users', { profile: JSON.stringify(claims) }, [{ column: 'issuer', value: config.issuer }, { column: 'subject', value: subject }, tenantScope('owner_tid')]));
		if (account.status !== 'enabled') return apiMessage(c, 403, '本站用户已停用');
		// 清 cookie 必须排在建会话**之前**：c.header 不带 append 是覆盖语义，
		// 放在后面会把 createAccountsSession 追加的 base_session 一起抹掉。
		c.header('Set-Cookie', clearAccountsLoginCookie(isSecureRequest(c)));
		await createAccountsSession(c, systemDatabase, account.user_id, config.issuer, oidcSessionId);
		await runSql(systemDatabase, sql({ database: systemDatabase }).delete('base_oidc_login_requests', { request_id: request.id }));
		const context = await c.get('apiContext')?.(request.return_path);
		// 登录只在弹窗里完成：直接返回关闭窗口的页面，不再中转到额外的回调页面。
		return c.html(popupClosePage(request.return_path, context));
	} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Accounts 登录回调失败'); }
};
export default handler;
