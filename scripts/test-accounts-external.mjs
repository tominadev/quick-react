import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-accounts-external-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
const originalFetch = globalThis.fetch;
let deliveredCode = '';

globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	if (url.href === 'https://oauth2.googleapis.com/token') {
		const body = new URLSearchParams(String(init?.body ?? ''));
		assert.equal(body.get('client_secret'), 'google-secret');
		return Response.json({ access_token: `google-token-${body.get('code')}` });
	}
	if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
		const authorization = new Headers(init?.headers).get('authorization') ?? '';
		// google-conflict：同一个邮箱的另一个 Google 账号；google-bind：完全独立的 Google 账号。
		if (authorization.includes('google-bind')) return Response.json({ sub: 'google-subject-3', name: 'Google Bind', email: 'google-bind@example.com', email_verified: true });
		const conflict = authorization.includes('google-conflict');
		return Response.json({ sub: conflict ? 'google-subject-2' : 'google-subject-1', name: 'Google Account', email: 'google@example.com', email_verified: true });
	}
	if (url.origin === 'https://api.weixin.qq.com' && url.pathname.endsWith('/access_token')) {
		const code = url.searchParams.get('code') ?? '';
		return Response.json({ access_token: `wechat-access-${code}`, openid: code === 'wechat-existing-email' ? 'wechat-openid-existing' : 'wechat-openid-1' });
	}
	if (url.origin === 'https://api.weixin.qq.com' && url.pathname.endsWith('/userinfo')) {
		const accessToken = url.searchParams.get('access_token') ?? '';
		return Response.json({ openid: accessToken.includes('wechat-existing-email') ? 'wechat-openid-existing' : 'wechat-openid-1', nickname: '微信测试用户' });
	}
	if (url.href === 'https://dm.aliyuncs.com/') {
		const body = new URLSearchParams(String(init?.body ?? ''));
		assert.equal(body.get('Action'), 'SingleSendMail');
		const template = JSON.parse(body.get('Template'));
		deliveredCode = String(template.TemplateData.code);
		return Response.json({ RequestId: 'external-email-request', EnvId: 'external-email-message' });
	}
	return originalFetch(input, init);
};

const cookie = (response, name) => response.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value.startsWith(`${name}=`));
const deviceKey = '00000000000040008000000000000001';
const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
const withFingerprint = (headers = {}) => ({ 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData, ...headers });
const redirectTarget = async (response) => {
	const location = response.headers.get('location');
	if (location) return location;
	const html = await response.text();
	const match = html.match(/<script>location\.href=([^;]+);<\/script>/s);
	assert.ok(match, '200 跳转页必须包含前端跳转地址');
	return JSON.parse(match[1]);
};
const jsonRequest = (app, path, body, requestCookie = '') => app.request(`http://accounts.test${path}`, { method: 'POST', headers: withFingerprint({ 'content-type': 'application/json', ...(requestCookie ? { cookie: requestCookie } : {}) }), body: JSON.stringify(body) });

try {
	const { app } = await import(`../dist/server.mjs?accounts-external=${Date.now()}`);
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	database.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'accounts.test', 'passport', 'enabled', ?)").run(now);
	for (const provider of [
		['google', 'Google', 'google-client', 'google-secret'],
		['wechat', '微信', 'wechat-app-id', 'wechat-secret'],
	]) database.prepare(`INSERT INTO passport_external_providers (key, provider, title, client_id, client_secret, status, created_at, updated_at)
		VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'enabled', ?, ?)`).run(...provider, now, now);
	database.prepare(`INSERT INTO global_cloud_credentials (key, id, title, provider, access_key_id, access_key_secret, status, created_at, updated_at)
		VALUES (lower(hex(randomblob(16))), 91, 'external-email', 'aliyun', 'mail-key', 'mail-secret', 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_channels (key, id, cloud_credential_id, region, account_name, from_alias, reply_to_enabled, status, created_at, updated_at)
		VALUES (lower(hex(randomblob(16))), 92, 91, 'cn-hangzhou', 'noreply@example.com', 'Accounts', 0, 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_templates (id, key, type, title, subject, body_text, body_html, status, created_at, updated_at)
		VALUES (93, 'email_verification_external', 'email_verification', '外部身份邮箱验证码', '验证码 {{code}}', '验证码：{{code}}', '<p>验证码：{{code}}</p>', 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_template_publications (key, template_id, cloud_credential_id, region, provider_template_id, content_hash, status, created_at, updated_at)
		VALUES (lower(hex(randomblob(16))), 93, 91, 'cn-hangzhou', 'external-template', 'test', 'ready', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_bindings (key, site_key, channel_id, template_id, purpose, is_default, status, created_at, updated_at)
		VALUES (lower(hex(randomblob(16))), 'passport', 92, 93, 'email_verification', 1, 'enabled', ?, ?)`).run(now, now);
	database.close();

	// 登录页是邮箱输入框 + 第三方按钮；未注册的邮箱先让用户确认。
	const sign = await (await app.request('http://accounts.test/api/accounts/sign.php')).json();
	assert.equal(sign.formPage.initialValues.step, 'email');
	// 能直接提供已验证邮箱的身份源排在最前并标注推荐，新用户走这条路不需要邮箱验证码。
	assert.deepEqual(sign.formPage.externalLogins.map((item) => item.key), ['google', 'wechat']);
	assert.equal(sign.formPage.externalLogins[0].recommended, true);
	assert.equal(sign.formPage.externalLogins[0].hint, '新用户无需邮箱验证码');
	assert.equal(sign.formPage.externalLogins[1].recommended, undefined);
	assert.match(sign.formPage.description, /第三方账号/);
	const unknownEmail = await jsonRequest(app, '/api/accounts/sign.php', { step: 'email', email: 'wechat@example.com' });
	const unknownEmailResult = await unknownEmail.json();
	assert.equal(unknownEmail.status, 200);
	assert.equal(unknownEmailResult.formPage.initialValues.step, 'email_confirm');
	assert.match(unknownEmailResult.formPage.description, /还没有注册/);
	const confirmed = await jsonRequest(app, '/api/accounts/sign.php', { step: 'email_confirm', email: 'wechat@example.com' });
	const confirmedResult = await confirmed.json();
	assert.deepEqual(confirmedResult.formPage.fields.find((field) => field.name === 'method').options.map((item) => item.value), ['google', 'wechat']);
	const signupEmailCookie = cookie(confirmed, 'accounts_signup_email');
	assert.ok(signupEmailCookie);
	// 换个邮箱回到登录页第一步。
	const changed = await (await app.request('http://accounts.test/api/accounts/sign.php?action=change_email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'email_confirm', email: 'wechat@example.com' }) })).json();
	assert.equal(changed.formPage.initialValues.step, 'email');

	// 第三方按钮先由 API 响应保存短期设备传输 Cookie；OAuth 回调本身是浏览器导航，不能附加自定义请求头。
	const googleProviderAction = await jsonRequest(app, '/api/accounts/sign.php?action=provider:google', { step: 'email' });
	const transportCookies = googleProviderAction.headers.getSetCookie().filter((value) => /^device_key=/.test(value));
	assert.equal(transportCookies.length, 1);
	const googleStart = await app.request('http://accounts.test/api/accounts/external/google', { headers: { cookie: transportCookies.map((value) => value.split(';')[0]).join('; ') } });
	assert.equal(googleStart.status, 200);
	const googleStateCookie = cookie(googleStart, 'accounts_external_state');
	const googleAuthorization = new URL(await redirectTarget(googleStart));
	assert.equal(googleAuthorization.hostname, 'accounts.google.com');
	assert.equal(googleAuthorization.searchParams.get('code_challenge_method'), 'S256');
	const googleState = googleAuthorization.searchParams.get('state');
	const googleCallback = await app.request(`http://accounts.test/api/accounts/external/google?code=google-code&state=${encodeURIComponent(googleState)}`, { headers: { cookie: `${googleStateCookie}; ${transportCookies.map((value) => value.split(';')[0]).join('; ')}` } });
	assert.equal(googleCallback.status, 200);
	const googleSession = cookie(googleCallback, 'passport_session');
	assert.ok(googleSession);
	assert.ok(!googleCallback.headers.getSetCookie().some((value) => value.startsWith('device_key=;')));
	// 新用户还没有用户名，回到登录页继续补全。
	assert.match(await redirectTarget(googleCallback), /^\/accounts\/sign/);
	const afterGoogle = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(afterGoogle.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'google'").get().count, 1);
	assert.equal(afterGoogle.prepare("SELECT COUNT(*) AS count FROM passport_emails WHERE email = 'google@example.com' AND verified = 1").get().count, 1);
	afterGoogle.close();
	assert.equal((await app.request(`http://accounts.test/api/accounts/external/google?code=replay&state=${encodeURIComponent(googleState)}`, { headers: withFingerprint({ cookie: googleStateCookie }) })).status, 400);
	const googleConflictStart = await app.request('http://accounts.test/api/accounts/external/google');
	const googleConflictAuthorization = new URL(await redirectTarget(googleConflictStart));
	const googleConflictState = googleConflictAuthorization.searchParams.get('state');
	// 另一个 Google 账号带着同一个已验证邮箱：身份源已经证明邮箱归属，直接绑定到已有账号并登录，不建新用户。
	const googleSameEmail = await app.request(`http://accounts.test/api/accounts/external/google?code=google-conflict&state=${encodeURIComponent(googleConflictState)}`, { headers: withFingerprint({ cookie: cookie(googleConflictStart, 'accounts_external_state') }) });
	assert.equal(googleSameEmail.status, 200);
	await redirectTarget(googleSameEmail);
	assert.ok(cookie(googleSameEmail, 'passport_session'), '同邮箱的第三方身份应该直接登录');
	const afterConflict = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(afterConflict.prepare('SELECT COUNT(*) AS count FROM passport_users').get().count, 1, '不应该创建新用户');
	assert.equal(afterConflict.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'google'").get().count, 2, '新身份应该绑定到同一个账号');
	assert.equal(afterConflict.prepare("SELECT COUNT(DISTINCT user_key) AS count FROM passport_external_identities WHERE provider = 'google'").get().count, 1);
	afterConflict.close();
	// 微信没有邮箱：验证一个已属于 Accounts 用户的邮箱后，应把微信身份绑定到该用户，而不是拒绝或创建新用户。
	const existingWechatStart = await app.request('http://accounts.test/api/accounts/external/wechat');
	const existingWechatAuthorization = new URL(await redirectTarget(existingWechatStart));
	const existingWechatState = existingWechatAuthorization.searchParams.get('state');
	const existingWechatCallback = await app.request(`http://accounts.test/api/accounts/external/wechat?code=wechat-existing-email&state=${encodeURIComponent(existingWechatState)}`, { headers: withFingerprint({ cookie: cookie(existingWechatStart, 'accounts_external_state') }) });
	const existingWechatPending = cookie(existingWechatCallback, 'accounts_external_pending');
	assert.ok(existingWechatPending);
	const existingWechatEmail = await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_email', email: 'google@example.com' }, existingWechatPending);
	assert.equal(existingWechatEmail.status, 200);
	const existingWechatVerified = await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_verify', code: deliveredCode }, existingWechatPending);
	assert.equal(existingWechatVerified.status, 200);
	const existingWechatResult = await existingWechatVerified.json();
	const existingWechatDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	const googleOwner = existingWechatDatabase.prepare("SELECT CAST(ue.user_key AS TEXT) AS user_key FROM passport_user_emails ue JOIN passport_emails e ON e.id = ue.email_id WHERE e.email = 'google@example.com'").get().user_key;
	const wechatOwner = existingWechatDatabase.prepare("SELECT CAST(user_key AS TEXT) AS user_key FROM passport_external_identities WHERE provider = 'wechat' AND subject = 'wechat-app-id:wechat-openid-existing'").get().user_key;
	assert.equal(String(existingWechatResult.user.id), googleOwner, '已有邮箱绑定微信后应登录同一 Accounts 用户');
	assert.equal(wechatOwner, googleOwner);
	existingWechatDatabase.close();
	// 验证码页面必须明确显示收件地址，并允许回到邮箱输入步骤。
	const changeEmailStart = await app.request('http://accounts.test/api/accounts/external/wechat');
	const changeEmailState = new URL(await redirectTarget(changeEmailStart)).searchParams.get('state');
	const changeEmailCallback = await app.request(`http://accounts.test/api/accounts/external/wechat?code=wechat-change-email&state=${encodeURIComponent(changeEmailState)}`, { headers: withFingerprint({ cookie: cookie(changeEmailStart, 'accounts_external_state') }) });
	const changeEmailPending = cookie(changeEmailCallback, 'accounts_external_pending');
	await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_email', email: 'wechat-change@example.com' }, changeEmailPending);
	const codePage = await (await app.request('http://accounts.test/api/accounts/sign.php', { headers: { cookie: changeEmailPending } })).json();
	assert.match(codePage.formPage.description, /wechat-change@example\.com/);
	assert.deepEqual(codePage.formPage.actions.map((action) => action.key), ['change_email']);
	const changedCodeEmail = await jsonRequest(app, '/api/accounts/sign.php?action=change_email', { step: 'external_verify' }, changeEmailPending);
	assert.equal((await changedCodeEmail.json()).formPage.initialValues.step, 'external_email');

	const forwardedHeaders = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'passport.example.test' };
	const wechatStart = await app.request('http://accounts.test/api/accounts/external/wechat', { headers: withFingerprint(forwardedHeaders) });
	const wechatStateCookie = cookie(wechatStart, 'accounts_external_state');
	const wechatAuthorization = new URL(await redirectTarget(wechatStart));
	assert.equal(wechatAuthorization.hostname, 'open.weixin.qq.com');
	assert.equal(wechatAuthorization.searchParams.get('scope'), 'snsapi_login');
	assert.equal(wechatAuthorization.searchParams.get('redirect_uri'), 'https://accounts.test/api/accounts/external/wechat');
	const wechatState = wechatAuthorization.searchParams.get('state');
	const wechatCallback = await app.request(`http://accounts.test/api/accounts/external/wechat?code=wechat-code&state=${encodeURIComponent(wechatState)}`, { headers: withFingerprint({ ...forwardedHeaders, cookie: wechatStateCookie }) });
	assert.equal(wechatCallback.status, 200);
	await redirectTarget(wechatCallback);
	const pendingCookie = cookie(wechatCallback, 'accounts_external_pending');
	assert.ok(pendingCookie);
	const beforeEmail = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(beforeEmail.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'wechat'").get().count, 1);
	assert.equal(beforeEmail.prepare('SELECT COUNT(*) AS count FROM passport_users').get().count, 1);
	beforeEmail.close();
	const emailForm = await (await app.request('http://accounts.test/api/accounts/sign.php', { headers: withFingerprint({ cookie: `${pendingCookie}; ${signupEmailCookie}` }) })).json();
	assert.equal(emailForm.formPage.initialValues.step, 'external_email');
	// 第一步输入过的邮箱会预填到验证步骤。
	assert.equal(emailForm.formPage.initialValues.email, 'wechat@example.com');
	const issued = await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_email', email: 'wechat@example.com' }, pendingCookie);
	assert.equal(issued.status, 200);
	assert.match(deliveredCode, /^\d{6}$/);
	assert.equal((await (await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_verify', code: '000000' }, pendingCookie)).json()).feedback.type, 'error');
	const verified = await jsonRequest(app, '/api/accounts/sign.php', { step: 'external_verify', code: deliveredCode }, pendingCookie);
	assert.equal(verified.status, 200);
	const wechatSession = cookie(verified, 'passport_session');
	assert.ok(wechatSession);
	// 邮箱 wechat@example.com 的 @ 前面合规且没被占用，用户名自动定为 wechat，
	// 不再打扰用户；接着才是可跳过的设置密码。
	const verifiedResult = await verified.json();
	assert.equal(verifiedResult.formPage.initialValues.step, 'set_password');
	assert.equal(verifiedResult.redirectTo, undefined);
	const completed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'wechat'").get().count, 2);
	assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM passport_emails WHERE email = 'wechat@example.com' AND verified = 1").get().count, 1);
	assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM passport_external_pending_identities WHERE status = 'completed'").get().count, 2);
	completed.close();
	// 用户名已自动定下，改名仍走同一个 step，格式限制不变。
	const autoNamed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(autoNamed.prepare("SELECT name FROM passport_users WHERE name = 'wechat'").get()?.name, 'wechat');
	autoNamed.close();
	// 下限 3、上限 16；大写、下划线、数字开头、保留名、超长都要拒。
	for (const candidate of ['ab', 'Wechat1', 'wechat_1', '1wechat', 'admin', 'wechatuser2026xyz']) {
		const rejected = await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_user_name', user_name: candidate }, wechatSession);
		assert.equal(rejected.status, 400, `用户名 ${candidate} 应该被拒绝`);
	}
	const namedResponse = await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_user_name', user_name: 'wechat2026' }, wechatSession);
	const named = await namedResponse.json();
	assert.equal(namedResponse.status, 200);
	assert.equal(named.formPage.initialValues.step, 'set_password');
	assert.deepEqual(named.formPage.actions.map((action) => action.key), ['skip_password']);
	assert.equal((await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_user_name', user_name: 'wechat2027' }, wechatSession)).status, 200);
	const skipped = await (await app.request('http://accounts.test/api/accounts/sign.php?action=skip_password', { method: 'POST', headers: withFingerprint({ 'content-type': 'application/json', cookie: wechatSession }), body: JSON.stringify({ step: 'set_password' }) })).json();
	assert.equal(skipped.redirectTo, '/panel/accounts.html');
	// 跳过只对本次登录生效，下次进入登录页仍然提示设置密码。
	assert.equal((await (await app.request('http://accounts.test/api/accounts/sign.php', { headers: withFingerprint({ cookie: wechatSession }) })).json()).formPage.initialValues.step, 'set_password');
	assert.equal((await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_password', password: 'wechat-password-1', password_confirm: 'other' }, wechatSession)).status, 400);
	assert.equal((await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_password', password: 'short', password_confirm: 'short' }, wechatSession)).status, 400);
	const savedPassword = await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_password', password: 'wechat-password-1', password_confirm: 'wechat-password-1' }, wechatSession);
	assert.equal(savedPassword.status, 200);
	assert.equal((await savedPassword.json()).redirectTo, '/panel/accounts.html');
	// 设置完成后登录页显示已登录状态，绑定身份统一从账户中心进入。
	assert.deepEqual((await (await app.request('http://accounts.test/api/accounts/sign.php', { headers: withFingerprint({ cookie: wechatSession }) })).json()).formPage.actions.map((action) => action.key), ['account_center', 'bind_identity', 'logout']);

	// 已注册邮箱走密码登录：第一步给出密码表单，密码错误有提示。
	const knownEmail = await (await jsonRequest(app, '/api/accounts/sign.php', { step: 'email', email: 'wechat@example.com' })).json();
	assert.equal(knownEmail.formPage.initialValues.step, 'password');
	assert.deepEqual(knownEmail.formPage.actions.map((item) => item.key), ['forgot_password', 'change_email']);
	const wrongPassword = await (await jsonRequest(app, '/api/accounts/sign.php', { step: 'password', email: 'wechat@example.com', password: 'wrong-password' })).json();
	assert.match(wrongPassword.feedback.message, /邮箱或密码不正确/);
	// 忘记密码必须先做第三方认证。
	const forgot = await app.request('http://accounts.test/api/accounts/sign.php?action=forgot_password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'password', email: 'wechat@example.com' }) });
	const forgotResult = await forgot.json();
	assert.equal(forgotResult.formPage.initialValues.step, 'method');
	assert.match(forgotResult.formPage.description, /重设.*密码需要先完成一次第三方认证/);
	assert.ok(cookie(forgot, 'accounts_password_reset'));
	assert.equal((await jsonRequest(app, '/api/accounts/sign.php', { step: 'reset_password', password: 'new-password-1', password_confirm: 'new-password-1' }, wechatSession)).status, 409);
	const passwordLogin = await jsonRequest(app, '/api/accounts/sign.php', { step: 'password', email: 'wechat@example.com', password: 'wechat-password-1' });
	assert.equal(passwordLogin.status, 200);
	assert.ok(cookie(passwordLogin, 'passport_session'));
	assert.equal((await passwordLogin.json()).redirectTo, '/panel/accounts.html');

	// 已登录后再绑定一个新的第三方身份：user_id 是雪花 ID，查询必须按文本读取，否则会报数值溢出。
	const bindStart = await app.request('http://accounts.test/api/accounts/external/google');
	const bindState = new URL(await redirectTarget(bindStart)).searchParams.get('state');
	const bindCallback = await app.request(`http://accounts.test/api/accounts/external/google?code=google-bind&state=${encodeURIComponent(bindState)}`, { headers: withFingerprint({ cookie: `${cookie(bindStart, 'accounts_external_state')}; ${wechatSession}` }) });
	assert.equal(bindCallback.status, 200, '绑定新身份应该成功');
	await redirectTarget(bindCallback);
	const boundIdentities = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(boundIdentities.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'google'").get().count, 3);
	assert.equal(boundIdentities.prepare("SELECT COUNT(*) AS count FROM passport_emails WHERE email = 'google-bind@example.com' AND verified = 1").get().count, 1, '绑定 Google 时应自动加入其已验证邮箱');
	boundIdentities.close();

	// 用户名被占用时也要给出明确提示，而不是数值溢出错误。
	const takenUsername = await jsonRequest(app, '/api/accounts/sign.php', { step: 'set_user_name', user_name: 'wechat2027' }, googleSession);
	assert.equal(takenUsername.status, 400);
	assert.match((await takenUsername.json()).feedback.message, /已被占用/);

	// 已绑定过的微信身份再次登录：直接建立会话，不再发验证码、也不再进注册流程。
	deliveredCode = '';
	const returningStart = await app.request('http://accounts.test/api/accounts/external/wechat');
	const returningState = new URL(await redirectTarget(returningStart)).searchParams.get('state');
	const returningCallback = await app.request(`http://accounts.test/api/accounts/external/wechat?code=wechat-code&state=${encodeURIComponent(returningState)}`, { headers: withFingerprint({ cookie: cookie(returningStart, 'accounts_external_state') }) });
	assert.equal(returningCallback.status, 200);
	await redirectTarget(returningCallback);
	assert.ok(cookie(returningCallback, 'passport_session'), '老用户应该直接拿到会话');
	assert.equal(cookie(returningCallback, 'accounts_external_pending'), undefined, '不应该再进入待注册状态');
	assert.equal(deliveredCode, '', '老用户登录不应该发送验证码');
	const returningDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(returningDatabase.prepare('SELECT COUNT(*) AS count FROM passport_users').get().count, 2, '不应该重复创建用户');
	assert.equal(returningDatabase.prepare("SELECT COUNT(*) AS count FROM passport_external_identities WHERE provider = 'wechat'").get().count, 2);
	returningDatabase.close();

	const modeDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	modeDatabase.prepare("UPDATE passport_external_providers SET wechat_mode = 'official_account' WHERE provider = 'wechat'").run();
	modeDatabase.close();
	const officialWechatStart = await app.request('http://accounts.test/api/accounts/external/wechat');
	assert.equal(officialWechatStart.status, 302);
	assert.match(officialWechatStart.headers.get('location'), /\/accounts\/external\/wechat/);
	console.log('accounts external identity test passed');
} finally {
	globalThis.fetch = originalFetch;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
