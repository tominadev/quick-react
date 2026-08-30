import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { ensurePassportDevice } from '@server/modules/passport/device.mjs';
import { bindReturnCookieName, clearBindReturnCookie, clearExternalStateCookie, consumeExternalState, createExternalState, createPendingExternalIdentity, discardExternalEmailOtp, externalAuthorizationUrl, externalPendingCookie, externalProvider, externalQrState, externalStateCookie, externalIdentityUser, externalStateCookieName, externalVerifiedCookie, fetchExternalProfile, issueExternalEmailOtp, pendingExternalIdentityByQrState, resolveExternalUser, verifyExternalEmailOtp, type ExternalProviderId } from '@server/modules/passport/accounts/external.mjs';
import { oidcRequestCookie, oidcRequestCookieName, readCookie } from '@server/modules/passport/accounts/oidc.mjs';
import { postLoginRedirect } from '@server/modules/passport/accounts/onboarding.mjs';
import { externalAvatarUrl, syncExternalAvatar } from '@server/modules/passport/avatar.mjs';
import { createPassportSessionCookie, loadPassportSession } from '@server/modules/passport/session.mjs';
import { runSql, sql } from '@server/database/sql.mjs';
import { isSecureRequest, requestOrigin } from '@server/modules/base/request-origin.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';
import { sendDefaultCloudEmail } from '@server/modules/global/cloud/email.mjs';
import { renderExternalRedirect } from '@server/templates/passport/api/accounts/external.mjs';
import { clearDeviceFingerprintTransportCookie, clearDeviceKeyTransportCookie } from '@server/modules/base/device-fingerprint.mjs';

const providerId = (value: string): ExternalProviderId | undefined => value === 'google' || value === 'wechat' ? value : undefined;
const sameRedirectUri = (left: string, right: string) => {
	try {
		const a = new URL(left), b = new URL(right);
		return a.host === b.host && a.pathname === b.pathname && a.search === b.search;
	} catch { return false; }
};

const handler: ApiHandler = async (c, _next, params) => {
	if (!['GET', 'POST'].includes(c.req.method)) return apiMessage(c, 404);
	const database = c.get('passportDatabase'), id = providerId(params.id);
	if (!database) return apiMessage(c, 503, 'Accounts 数据库不可用');
	if (!id) return apiMessage(c, 404, '外部身份源不存在');
	const provider = await externalProvider(database, id);
	if (!provider) return apiMessage(c, 404, `${id === 'google' ? 'Google' : '微信'}登录尚未启用`);
	const secure = isSecureRequest(c);
	const bindState = c.req.query('bind')?.trim();
	if (c.req.method === 'POST' && bindState) {
		const pending = await pendingExternalIdentityByQrState(database, bindState);
		if (!pending || pending.provider !== id) return apiMessage(c, 410, '邮箱绑定状态不存在或已过期，请重新扫码');
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({})) as Record<string, unknown>;
		const step = String(body.step ?? 'email');
		if (step === 'email') {
			let issued: Awaited<ReturnType<typeof issueExternalEmailOtp>>;
			try { issued = await issueExternalEmailOtp(database, pending, String(body.email ?? '')); }
			catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '邮箱不合法'); }
			try { await sendDefaultCloudEmail(c.get('globalDatabase'), c.get('site').siteKey, 'email_verification', issued.email, { code: issued.code, email: issued.email, expires_minutes: '10' }); }
			catch (error) { await discardExternalEmailOtp(database, pending.id_hash); return apiMessage(c, 502, error instanceof Error ? error.message : '邮箱验证码发送失败'); }
			return apiResponse(c, 200, { status: 'email_sent' });
		}
		const verified = await verifyExternalEmailOtp(database, c.env.SNOWFLAKE_WORKER_ID, pending, String(body.code ?? ''));
		if (verified.status !== 'created') return apiMessage(c, 409, verified.status === 'conflict' ? verified.message : verified.status === 'expired' ? '验证码已过期' : '验证码不正确');
		const sessionId = crypto.randomUUID(), now = Date.now(), maxAge = 24 * 60 * 60;
		await runSql(database, sql({ database }).insert('passport_sessions', { token_hash: await sha256(sessionId), user_id: verified.userId, device_id: await ensurePassportDevice(database, verified.userId, c.req.raw, c.get('clientIp'), c.get('transportIp')), expires_at: now + maxAge * 1000 }));
		await runSql(database, sql({ database }).update('passport_external_login_states', { qr_status: 'consumed', qr_user_id: verified.userId }, { id_hash: await sha256(bindState) }));
		c.header('Set-Cookie', createPassportSessionCookie(sessionId, secure, maxAge));
		c.header('Set-Cookie', clearDeviceKeyTransportCookie(secure), { append: true });
		c.header('Set-Cookie', clearDeviceFingerprintTransportCookie(secure), { append: true });
		// 二维码页可能开在业务站点的登录弹窗里，必须把后续去向一并返回，不能让它自己跳首页。
		return apiResponse(c, 200, { status: 'completed', redirectTo: await postLoginRedirect(c, database, verified.userId) });
	}
	if (c.req.method !== 'GET') return apiMessage(c, 400, '缺少邮箱绑定状态');
	const publicOrigin = c.get('systemConfig').publicOrigin?.trim();
	// 微信网页授权域名在平台侧按 HTTPS 注册，始终使用该公开域名生成回调地址。
	const configuredOrigin = id === 'wechat' && provider.wechat_redirect_domain ? `https://${provider.wechat_redirect_domain}` : (publicOrigin || requestOrigin(c));
	const redirectUri = new URL(`/api/accounts/external/${id}`, configuredOrigin).toString();
	const code = c.req.query('code')?.trim();
	const rawReturnedState = c.req.query('state')?.trim() ?? '';
	const qrFlow = rawReturnedState.endsWith('.qr');
	const returnedState = qrFlow ? rawReturnedState.slice(0, -3) : rawReturnedState;
	const rawPollState = c.req.query('poll')?.trim() ?? '';
	const pollState = rawPollState.endsWith('.qr') ? rawPollState.slice(0, -3) : rawPollState;
	if (pollState) {
		const polled = await externalQrState(database, await sha256(pollState));
		// 过期是正常轮询结果，不能用错误状态码，否则通用请求层会弹出"请求失败"。
		if (!polled || polled.provider !== id || polled.expires_at <= Date.now()) return apiResponse(c, 200, { status: 'expired' });
		if (polled.qr_status === 'authorized' && !polled.qr_user_id) return apiResponse(c, 200, { status: 'needs_email', bindUrl: `/api/accounts/external/${id}?bind=${encodeURIComponent(pollState)}` });
		if (polled.qr_status !== 'authorized' || !polled.qr_user_id) return apiResponse(c, 200, { status: polled.qr_status });
		const current = await loadPassportSession(database, c.req.raw);
		const sessionId = crypto.randomUUID(), now = Date.now();
		let deviceId: string;
		try {
			deviceId = await ensurePassportDevice(database, polled.qr_user_id, c.req.raw, c.get('clientIp'), c.get('transportIp'));
		} catch (error) {
			// 轮询是正常的状态查询；设备冲突不能让接口变成未处理异常的 500。
			return apiResponse(c, 200, { status: 'error', error: error instanceof Error ? error.message : String(error) });
		}
		await runSql(database, sql({ database }).insert('passport_sessions', { token_hash: await sha256(sessionId), user_id: polled.qr_user_id, device_id: deviceId, expires_at: now + 24 * 60 * 60 * 1000 }));
		await runSql(database, sql({ database }).update('passport_external_login_states', { qr_status: 'consumed' }, [{ column: 'id_hash', value: await sha256(pollState) }, { column: 'qr_status', value: 'authorized' }]));
		c.header('Set-Cookie', createPassportSessionCookie(sessionId, secure, 24 * 60 * 60));
		c.header('Set-Cookie', clearDeviceKeyTransportCookie(secure), { append: true });
		c.header('Set-Cookie', clearDeviceFingerprintTransportCookie(secure), { append: true });
		const redirectTo = current && String(current.id) === String(polled.qr_user_id)
			? `/panel/accounts/identities${c.get('techStackConfig').pageSuffix}`
			: await postLoginRedirect(c, database, String(polled.qr_user_id), polled.oidc_request_id ?? undefined);
		if (polled.oidc_request_id) c.header('Set-Cookie', oidcRequestCookie(polled.oidc_request_id, secure), { append: true });
		return apiResponse(c, 200, { status: 'authenticated', redirectTo });
	}
	if (!code && !returnedState) {
		const created = await createExternalState(database, id, redirectUri, readCookie(c.req.raw, oidcRequestCookieName));
		// 二维码在电脑端发起时记住当前 Accounts 用户；手机只负责确认外部身份，电脑端无需再次走邮箱验证。
		if (id === 'wechat' && provider.wechat_mode === 'official_account') {
			const current = await loadPassportSession(database, c.req.raw);
			if (current) await runSql(database, sql({ database }).update('passport_external_login_states', { qr_user_id: String(current.id) }, { id_hash: await sha256(created.state) }));
		}
		c.header('Set-Cookie', externalStateCookie(created.state, secure));
		const authorizationUrl = await externalAuthorizationUrl(provider, redirectUri, created.state, created.nonce, created.codeVerifier);
		const isWechatClient = /MicroMessenger/i.test(c.req.header('user-agent') ?? '');
		if (id === 'wechat' && provider.wechat_mode === 'official_account' && !isWechatClient) {
			if (c.req.query('format') === 'json') {
				const fallback = new URL(`/accounts/sign${c.get('techStackConfig').pageSuffix || ''}`, requestOrigin(c));
				if (c.req.query('popup') === '1') fallback.searchParams.set('popup', '1');
				const qrAuthorizationUrl = new URL(authorizationUrl);
				qrAuthorizationUrl.searchParams.set('state', `${created.state}.qr`);
				return apiResponse(c, 200, { mode: 'qrcode', authorizationUrl: qrAuthorizationUrl.toString(), pollUrl: `/api/accounts/external/${id}?poll=${created.state}.qr`, fallbackUrl: `${fallback.pathname}${fallback.search}` });
			}
			const pageSuffix = c.get('techStackConfig').pageSuffix || '';
			const qrPage = new URL(`/accounts/external/${id}${pageSuffix}`, requestOrigin(c));
			if (c.req.query('popup') === '1') qrPage.searchParams.set('popup', '1');
			return c.redirect(qrPage.toString(), 302);
		}
		const providerName = id === 'google' ? 'Google' : '微信';
		return c.html(renderExternalRedirect(authorizationUrl, `正在前往${providerName}登录`), 200);
	}
	const consume = c.req.query('consume') === '1';
	if (id === 'wechat' && provider.wechat_mode === 'official_account' && (code || c.req.query('error')) && !consume) {
		const pageSuffix = c.get('techStackConfig').pageSuffix || '';
		const target = new URL(`/accounts/external/callback${pageSuffix}`, requestOrigin(c));
		for (const key of ['provider', 'code', 'state', 'error', 'error_description']) { const value = c.req.query(key); if (value) target.searchParams.set(key, value); }
		return c.redirect(target.toString(), 302);
	}
	const providerError = c.req.query('error');
	if (providerError) {
		c.header('Set-Cookie', clearExternalStateCookie(secure));
		return apiMessage(c, 400, `外部授权未完成：${c.req.query('error_description') || providerError}`);
	}
	if (!code || !returnedState) return apiMessage(c, 400, '外部授权回调缺少 code 或 state');
	const cookieState = readCookie(c.req.raw, externalStateCookieName);
	if ((!cookieState || cookieState !== returnedState) && !(id === 'wechat' && provider.wechat_mode === 'official_account')) return apiMessage(c, 400, '外部授权 state 与当前浏览器不匹配，请重新登录');
	const qrState = id === 'wechat' && provider.wechat_mode === 'official_account' && qrFlow
		? await externalQrState(database, await sha256(returnedState))
		: null;
	// 手机回调页刷新或重复挂载时，已完成的扫码结果直接复用，不能再次消费一次性 state。
	if (consume && qrState?.qr_status === 'authorized') {
		return apiResponse(c, 200, { status: qrState.qr_user_id ? 'signed_in' : 'authorized' });
	}
	const state = await consumeExternalState(database, returnedState);
	if (!state) return apiMessage(c, 400, `外部授权 state 无效、已过期或已经使用：${returnedState.slice(0, 12)}…`);
	if (state.provider !== id) return apiMessage(c, 400, `外部授权提供方不匹配：请求为 ${id}，state 属于 ${state.provider}`);
	if (!sameRedirectUri(state.redirect_uri, redirectUri)) return apiMessage(c, 400, `外部授权回调地址不匹配：实际为 ${redirectUri}，state 允许 ${state.redirect_uri}`);
	try {
		const profile = await fetchExternalProfile(provider, code, state, c.env.OIDC_FETCH ?? fetch);
		const current = await loadPassportSession(database, c.req.raw);
		// 已经绑定过的外部身份直接登录，即使身份源不提供邮箱也不再要求验证码。
		const bound = await externalIdentityUser(database, provider.id, profile.subject);
		if (!current && !bound && !profile.email) {
			if (provider.wechat_mode === 'official_account' && qrFlow && consume) {
				if (qrState?.qr_user_id) {
					const userId = await resolveExternalUser(database, c.env.SNOWFLAKE_WORKER_ID, provider, profile, qrState.qr_user_id);
					await runSql(database, sql({ database }).update('passport_external_login_states', { qr_status: 'authorized', qr_user_id: userId }, { id_hash: await sha256(returnedState) }));
					return apiResponse(c, 200, { status: 'authorized' });
				}
				await createPendingExternalIdentity(database, profile, provider.id, await sha256(returnedState));
				await runSql(database, sql({ database }).update('passport_external_login_states', { qr_status: 'authorized' }, [{ column: 'id_hash', value: await sha256(returnedState) }]));
				return apiResponse(c, 200, { status: 'authorized' });
			}
			const pendingToken = await createPendingExternalIdentity(database, profile, provider.id);
			c.header('Set-Cookie', clearExternalStateCookie(secure));
			c.header('Set-Cookie', externalPendingCookie(pendingToken, secure), { append: true });
			return c.html(renderExternalRedirect(`/accounts/sign${c.get('techStackConfig').pageSuffix}`, '正在返回 Passport 登录', '外部身份已确认，正在返回 Passport…'), 200);
		}
		const userId = await resolveExternalUser(database, c.env.SNOWFLAKE_WORKER_ID, provider, profile, current?.id ? String(current.id) : undefined);
		if (state.oidc_request_id) c.header('Set-Cookie', oidcRequestCookie(state.oidc_request_id, secure), { append: true });
		// 身份源带头像时后台同步到对象存储，失败不影响登录。
		const avatarUrl = externalAvatarUrl(provider.id, profile.raw);
		if (avatarUrl) {
			const task = syncExternalAvatar(c.get('globalDatabase'), c.get('site').siteKey, userId, avatarUrl, c.env.OIDC_FETCH ?? fetch)
				.catch((error) => console.error('头像同步失败', error));
			try { c.executionCtx.waitUntil(task); }
			catch { void task; }
		}
		if (provider.wechat_mode === 'official_account' && qrFlow) {
			await runSql(database, sql({ database }).update('passport_external_login_states', { qr_status: 'authorized', qr_user_id: userId }, [{ column: 'id_hash', value: await sha256(returnedState) }]));
			// consume=1 来自手机上的回调页面，它按 JSON 解析响应；直接用浏览器打开时才返回提示页面。
			return consume ? apiResponse(c, 200, { status: 'signed_in' }) : c.html('<p>授权成功，请返回电脑页面。</p>');
		}
		// 有待处理的业务站点 OIDC 请求时，这是登录流程，不是账户中心的“绑定身份”流程。
		// 只有明确没有 OIDC 请求时，已登录账号才进入绑定身份分支。
		if (current && !state.oidc_request_id && !readCookie(c.req.raw, oidcRequestCookieName)) {
			// 已登录用户完成一次第三方认证：用于绑定身份、绑定邮箱或重设密码，按发起页面返回。
			c.header('Set-Cookie', clearExternalStateCookie(secure));
			c.header('Set-Cookie', externalVerifiedCookie(secure), { append: true });
			c.header('Set-Cookie', clearDeviceKeyTransportCookie(secure), { append: true });
			c.header('Set-Cookie', clearDeviceFingerprintTransportCookie(secure), { append: true });
			const requested = readCookie(c.req.raw, bindReturnCookieName) ?? '';
			const pageSuffix = c.get('techStackConfig').pageSuffix;
			// 只接受账户中心内部路径，避免被引导到站外。
			const bindTarget = /^\/panel\/accounts\/[a-z-]+(\.[a-z]+)?$/.test(requested) ? requested : `/panel/accounts/bind-email${pageSuffix}`;
			if (requested) c.header('Set-Cookie', clearBindReturnCookie(secure), { append: true });
			return consume ? apiResponse(c, 200, { status: 'linked', redirectTo: bindTarget }) : c.html(renderExternalRedirect(bindTarget, '正在返回 Passport', '身份验证完成，正在返回账户中心…'), 200);
		}
		const sessionId = crypto.randomUUID(), now = Date.now(), maxAge = 24 * 60 * 60;
		await runSql(database, sql({ database }).insert('passport_sessions', { token_hash: await sha256(sessionId), user_id: userId, device_id: await ensurePassportDevice(database, userId, c.req.raw, c.get('clientIp'), c.get('transportIp')), expires_at: now + maxAge * 1000 }));
		c.header('Set-Cookie', clearExternalStateCookie(secure));
		c.header('Set-Cookie', createPassportSessionCookie(sessionId, secure, maxAge), { append: true });
		c.header('Set-Cookie', clearDeviceKeyTransportCookie(secure), { append: true });
		c.header('Set-Cookie', clearDeviceFingerprintTransportCookie(secure), { append: true });
		// 第三方认证通过：30 分钟内允许发送邮箱验证码、重设密码。
		c.header('Set-Cookie', externalVerifiedCookie(secure), { append: true });
		// 去向由后端统一决定：先补全用户名和密码，再继续待处理的 OIDC 授权。
		const target = await postLoginRedirect(c, database, userId, state.oidc_request_id ?? undefined);
		// consume=1 来自手机上的回调页面，它按 JSON 解析响应，不能返回跳转。
		return consume ? apiResponse(c, 200, { status: 'signed_in', redirectTo: target }) : c.html(renderExternalRedirect(target, '正在返回 Passport', '登录成功，正在打开账户中心…'), 200);
	} catch (error) {
		c.header('Set-Cookie', clearExternalStateCookie(secure));
		const message = error instanceof Error ? error.message : '外部身份登录失败';
		return apiMessage(c, 400, message);
	}
};

export const acceptsTrailingParams = true;
export default handler;
