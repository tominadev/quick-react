import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { baseSessionMaxAge, clearSessionCookie, createSessionCookie, createStoredPassword, hashSessionToken, readSessionId, verifyStoredPassword } from '@server/modules/base/auth/index.mjs';
import { ensureBaseDevice } from '@server/modules/base/device.mjs';
import { finishUserCreation, resolveRegistrationMode } from '@server/modules/base/registration.mjs';
import { setCredential, verifyCredential } from '@server/modules/base/credentials.mjs';
import { allowsLocalLogin } from '@server/modules/passport/accounts/client.mjs';
import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';
import { firstSql, ownerScope, runSql, sql } from '@server/database/sql.mjs';
import { accountsLoginCookie, loadAccountsOidcConfig, loadDiscovery, oidcFetch } from '@server/modules/passport/accounts/client.mjs';
import { randomToken, sha256Base64Url } from '@server/modules/passport/accounts/oidc.mjs';
import { isSecureRequest, requestOrigin, requestPagePath } from '@server/modules/base/request-origin.mjs';
import { clearPassportSessionCookie } from '@server/modules/passport/session.mjs';
import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { userNameError } from '@shared/account-name.mjs';
import { profileNicknameOf } from '@server/modules/base/profile.mjs';
import { parseRoles } from '@shared/types/role.mjs';

const parseCredentials = async (c: Parameters<ApiHandler>[0]) => {
	let body: Record<string, unknown> = {};
	try { body = await c.req.json<Record<string, unknown>>(); }
	catch { /* Invalid JSON is handled as empty credentials. */ }
	return {
		user_name: String(body.user_name ?? '').trim().slice(0, 64),
		password: String(body.password ?? ''),
	};
};

/**
 * 账号行归属账号自己，而不是创建它的人。
 * 自增 id 要插入后才知道，因此回写一次；行级判定上线后，用户读自己的账号记录靠的就是它。
 */
/** 本站账号密码登录：Accounts 登录未启用时使用，也是启用后仍保留的站点管理员入口。 */
const localSign: ApiHandler = async (c, next) => {
	const database = c.get('database');
	// 登录、注册与引导状态都发生在会话建立之前：用绑定了主体的适配器会被 1 = 0 挡住。
	const systemDatabase = c.get('systemDatabase');
	if (c.req.method === 'GET') {
		const isSignUp = new URL(c.req.url).searchParams.get('mode') === 'sign-up';
		const formPage: FormPageConfig = {
			initialValues: { user_name: '', password: '', ...(isSignUp ? { password_confirm: '' } : {}) },
			submitLabel: isSignUp ? '注册' : '登录',
			fields: [
				{ name: 'user_name', label: '用户名', maxLength: 64, rules: [{ required: true, message: '请输入用户名' }] },
				{ name: 'password', label: '密码', type: 'password', rules: [{ required: true, message: '请输入密码' }] },
				...(isSignUp ? [{ name: 'password_confirm', label: '确认密码', type: 'password' as const, rules: [{ required: true, message: '请确认密码' }] }] : []),
			],
		};
		return apiResponse(c, 200, {
			user: c.get('currentUser') ?? null,
			registrationAvailable: await resolveRegistrationMode(c) !== 'closed',
			formPage,
		});
	}
	if (c.req.method === 'PUT') {
		const tenantId = c.get('tenantId');
		const mode = await resolveRegistrationMode(c);
		if (mode === 'closed') return apiMessage(c, 409, '本站未开放注册');
		const credentials = await parseCredentials(c);
		if (userNameError(credentials.user_name, c.get('siteSettings').userNameMinLength) || passwordError(credentials.password)) {
			return apiMessage(c, 400, '用户名至少 3 个合法字符，密码至少 8 个字符');
		}
		const storedPassword = await createStoredPassword(credentials.password);
		// 开放注册：直接建普通用户，用户名冲突交给唯一索引挡。没有闩要认领，
		// 因此也没有「认领了但没建号」的中间态需要回滚。
		if (mode === 'open') {
			try {
				await runSql(systemDatabase, sql({ database: systemDatabase }).insert('base_users', { name: credentials.user_name, roles: [], status: 'enabled' }));
			} catch { return apiMessage(c, 409, '用户名已存在'); }
			const userId = await finishUserCreation(systemDatabase, credentials.user_name, tenantId);
			if (userId !== undefined) await setCredential(systemDatabase, userId, storedPassword);
			return apiMessage(c, 201, '注册成功，请登录');
		}
		// 认领本租户的引导状态：唯一键是 (key, owner_tid)，同一租户内只可能成功一次，
		// 影响 0 行说明已被并发请求抢先。
		//
		// 引导流程不留痕：那时还没有会话，操作者与作用账号都是空的，而 base_bootstrap.value
		// 是脱敏列（§5），记下来只会是一条「value：已变更」——既说不出谁，也说不出改了什么。
		// 「初始管理员是什么时候建的」由 base_users.created_at 回答，不需要再抄一遍。
		const claimed = await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_bootstrap', { value: 'claimed' }, [{ column: 'name', value: 'initial_admin' }, { column: 'value', value: 'open' }, ...(tenantId === null ? [] : [{ column: 'owner_tid', value: tenantId }])]));
		if (Number(claimed.meta?.changes ?? 0) !== 1) return apiMessage(c, 409, '初始管理员已经存在');
		try {
			// 初始管理员是平台管理员：控制面与救援入口都要求它。
			await runSql(systemDatabase, sql({ database: systemDatabase }).insert('base_users', { name: credentials.user_name, roles: ['platform_admin'], status: 'enabled' }));
			const userId = await finishUserCreation(systemDatabase, credentials.user_name, tenantId);
			if (userId === undefined) throw new Error('无法创建初始管理员');
			await setCredential(systemDatabase, userId, storedPassword);
		} catch (error) {
			// 回滚本租户的认领，让下一次注册还能重试。
			await runSql(systemDatabase, sql({ database: systemDatabase }).update('base_bootstrap', { value: 'open' }, [{ column: 'name', value: 'initial_admin' }, { column: 'value', value: 'claimed' }, ...(tenantId === null ? [] : [{ column: 'owner_tid', value: tenantId }])]));
			throw error;
		}
		return apiMessage(c, 201, '初始管理员创建成功，请登录');
	}
	if (c.req.method === 'POST') {
		const credentials = await parseCredentials(c);
		// 用户名只在租户内唯一，登录必须按当前请求租户过滤：否则跨租户同名账号会被验到别人头上。
		const tenantId = c.get('tenantId');
		const user = await firstSql<{ id: number; user_name: string; profile_nickname: string | null; roles: string }>(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_users', alias: 'u', columns: { id: 'u.id', user_name: 'u.name', profile_nickname: 'p.nickname', roles: 'u.roles' }, joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }], where: [{ column: 'u.name', value: credentials.user_name }, { column: 'u.status', value: 'enabled' }, ownerScope('u.owner_tid', tenantId)] }));
		// 凭证分表存放：没有凭证行就是没有本地密码（例如 OIDC 建出来的账号）。
		// 提示统一成「用户名或密码错误」，不区分「无此用户」「没有本地密码」与「密码错」。
		if (!user || !await verifyCredential(systemDatabase, user.id, credentials.password)) return apiMessage(c, 401, '用户名或密码错误', { component: 'modal', type: 'error' });
		const sessionToken = crypto.randomUUID();
		const maxAge = baseSessionMaxAge;
		const now = Date.now();
		let deviceId: string;
		try { deviceId = await ensureBaseDevice(systemDatabase, user.id, c.req.raw, c.get('clientIp'), c.get('transportIp')); }
		catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '设备信息无效'); }
		// 会话归属登录人本人；此刻请求级适配器还没有归属用户，必须显式绑定，否则 owner_uid 为 NULL。
		const owned = withDatabaseActors(systemDatabase, { baseUserId: user.id });
		await runSql(owned, sql({ database: owned }).insert('base_sessions', { token_hash: await hashSessionToken(sessionToken), user_id: user.id, device_id: deviceId, expires_at: now + maxAge * 1000 }));
		c.header('Set-Cookie', createSessionCookie(sessionToken, new URL(c.req.url).protocol === 'https:', maxAge));
		c.set('currentUser', { id: user.id, user_name: user.user_name, profile_nickname: profileNicknameOf(user.user_name, user.profile_nickname), roles: parseRoles(user.roles) });
		return apiMessageData(c, 200, '登录成功', { user: { id: user.id, user_name: user.user_name }, next: { action: 'navigate', path: requestPagePath(c), refreshAuth: true } });
	}
	if (c.req.method === 'DELETE') {
		const sessionToken = readSessionId(c.req.raw);
		if (sessionToken) await runSql(database, sql({ database }).delete('base_sessions', { token_hash: await hashSessionToken(sessionToken) }));
		c.header('Set-Cookie', clearSessionCookie(new URL(c.req.url).protocol === 'https:'));
		c.set('currentUser', undefined);
		if (c.req.query('logout') !== 'local') {
			c.header('Set-Cookie', clearPassportSessionCookie(isSecureRequest(c)), { append: true });
			c.set('passportUser', undefined);
		}
		return apiMessageData(c, 200, '已退出登录', { next: { action: 'navigate', path: requestPagePath(c), refreshAuth: true } });
	}
	return next();
};

/** 登录入口：站点在系统设置里启用 Accounts 登录后走 OIDC，否则回落到本站账号密码登录。 */
const handler: ApiHandler = async (c, next) => {
	const config = await loadAccountsOidcConfig(c);
	if (allowsLocalLogin(c.get('accountsLoginMode'))) {
		// Accounts 登录不可用时，SDK 的登录请求不能被当成本地账号密码登录，否则会报"用户名或密码错误"。
		if (c.req.method === 'POST') {
			const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
			// both 模式两条路径并存，Accounts 的请求要放行给下游处理。
			const accountsRequest = body.action === 'login' || typeof body.step === 'string' || 'email' in body;
			if (accountsRequest && c.get('accountsLoginMode') === 'local') {
				return apiMessage(c, 409, body.action === 'login' ? '本站未启用 Accounts 登录，请使用本站账号密码登录' : '登录方式已切换为本地账号密码，请刷新页面后重试');
			}
			if (accountsRequest) return next();
		}
		return localSign(c, next, {});
	}
	if (c.req.method === 'GET') {
		const currentUser = c.get('currentUser') ?? null;
		const formPage: FormPageConfig = {
			description: '使用 Accounts 账号中心完成统一登录。点击下方按钮将打开 Accounts 登录窗口，完成后自动返回本站；本页不会自动跳转。',
			submitLabel: '前往 Accounts 登录',
			passportLogin: { enabled: true },
			initialValues: { action: 'login' },
			fields: [{ name: 'action', label: '', type: 'hidden' }],
		};
		return apiResponse(c, 200, { user: currentUser, registrationAvailable: false, formPage });
	}
	if (c.req.method === 'DELETE') {
		const database = c.get('database'), sessionToken = readSessionId(c.req.raw);
		const sessionHash = sessionToken ? await hashSessionToken(sessionToken) : undefined;
		const localOnly = c.req.query('logout') === 'local';
		const oidcSession = !localOnly && sessionHash ? await firstSql<{ sid: string }>(database, sql({ database }).select({
			table: 'base_oidc_sessions', alias: 'o', columns: { sid: 'o.sid' }, joins: [{ table: 'base_sessions', alias: 's', left: 's.id', right: 'o.session_id' }], where: [{ column: 'o.issuer', value: config.issuer }, { column: 's.token_hash', value: sessionHash }],
		})) : undefined;
		if (oidcSession) {
			try {
				const discovery = await loadDiscovery(c, config.issuer);
				const response = await oidcFetch(c, discovery.end_session_endpoint || `${config.issuer}/api/oidc/logout`, {
					method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, sid: oidcSession.sid }),
				});
				if (!response.ok) throw new Error(`Accounts 注销请求失败（HTTP ${response.status}）`);
			} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Accounts 注销失败'); }
		}
		if (sessionHash) await runSql(database, sql({ database }).delete('base_sessions', { token_hash: sessionHash }));
		c.header('Set-Cookie', clearSessionCookie(isSecureRequest(c)));
		c.set('currentUser', undefined);
		if (!localOnly) {
			c.header('Set-Cookie', clearPassportSessionCookie(isSecureRequest(c)), { append: true });
			c.set('passportUser', undefined);
		}
		return apiMessageData(c, 200, '已退出 Accounts 及所有关联站点', { next: { action: 'navigate', path: requestPagePath(c), refreshAuth: true } });
	}
	if (c.req.method === 'POST') {
		try {
			const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
			// 收到本站账号密码表单说明客户端拿的是旧页面：`user_name` 是那张表单的必有字段，
			// 认它就够了。
			if ('user_name' in body) return apiMessage(c, 409, '登录方式已切换为 Accounts 登录，请刷新页面后重试');
			const discovery = await loadDiscovery(c, config.issuer), id = crypto.randomUUID(), state = randomToken(), nonce = randomToken(), verifier = randomToken(48), now = Date.now();
			const database = c.get('database');
			let returnPath = '/';
			try {
				const referer = c.req.header('referer');
				if (referer) {
					const source = new URL(referer);
					if (source.origin === requestOrigin(c) && !source.pathname.startsWith('/api/')) returnPath = `${source.pathname}${source.search}`;
				}
			} catch { /* 无效 Referer 使用站点首页作为安全回退 */ }
			await runSql(database, sql({ database }).insert('base_oidc_login_requests', { request_id: id, issuer: config.issuer, state, nonce, code_verifier: verifier, return_path: returnPath, expires_at: now + 600_000 }));
			const callback = `${requestOrigin(c)}/api/accounts/oidc/callback`;
			const authorize = new URL(discovery.authorization_endpoint); authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: callback, scope: 'openid profile email', state, nonce, code_challenge: await sha256Base64Url(verifier), code_challenge_method: 'S256' }).toString();
			c.header('Set-Cookie', accountsLoginCookie(id, isSecureRequest(c)));
			return apiResponse(c, 200, { redirectTo: authorize.toString(), feedback: { component: 'message', type: 'success', message: '正在前往 Accounts 登录', redirectAfter: 0 } });
		} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Accounts 登录初始化失败'); }
	}
	if (c.req.method === 'PUT') return apiMessage(c, 403, '启用 Accounts 登录后不能创建本地用户');
	return localSign(c, next, {});
};
export default handler;
