import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-accounts-center-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
const originalFetch = globalThis.fetch;
let deliveredCode = '';
globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	if (url.href === 'https://dm.aliyuncs.com/') {
		const body = new URLSearchParams(String(init?.body ?? ''));
		deliveredCode = String(JSON.parse(body.get('Template')).TemplateData.code);
		return Response.json({ RequestId: 'center-email-request', EnvId: 'center-email-message' });
	}
	return originalFetch(input, init);
};

const userId = '1000000000000000001';
const primaryEmailId = '2000000000000000001';
const sessionId = 'accounts-center-session';
const deviceKey = '00000000-0000-4000-8000-000000000001';
const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
const localSessionToken = 'local-session';
const localSessionHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(localSessionToken))).toString('base64url');
const cookie = `passport_session=${sessionId}`;

try {
	const { app } = await import(`../dist/server.mjs?accounts-center=${Date.now()}`);
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	database.prepare("INSERT INTO global_site_hosts (hostname, site_key, status, created_at) VALUES ('accounts.test', 'passport', 'enabled', ?)").run(now);
	database.prepare(`INSERT INTO global_cloud_credentials (id, name, provider, access_key_id, access_key_secret, status, created_at, updated_at)
		VALUES (91, 'center-email', 'aliyun', 'mail-key', 'mail-secret', 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_channels (id, cloud_credential_id, region, account_name, from_alias, reply_to_address, status, created_at, updated_at)
		VALUES (92, 91, 'cn-hangzhou', 'noreply@example.com', 'Accounts', 0, 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_templates (id, key, type, name, subject, body_text, body_html, status, created_at, updated_at)
		VALUES (93, 'email_verification_center', 'email_verification', '账户中心邮箱验证码', '验证码 {{code}}', '验证码：{{code}}', '<p>验证码：{{code}}</p>', 'enabled', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_template_publications (template_id, cloud_credential_id, region, provider_template_id, content_hash, status, created_at, updated_at)
		VALUES (93, 91, 'cn-hangzhou', 'center-template', 'test', 'ready', ?, ?)`).run(now, now);
	database.prepare(`INSERT INTO global_cloud_email_bindings (site_key, channel_id, template_id, purpose, is_default, status, created_at, updated_at)
		VALUES ('passport', 92, 93, 'email_verification', 1, 'enabled', ?, ?)`).run(now, now);
	database.prepare("INSERT INTO passport_users (user_id, name, nickname, status, created_at, updated_at) VALUES (?, 'center2026', '账户中心用户', 'enabled', ?, ?)").run(userId, now, now);
	database.prepare("INSERT INTO passport_emails (id, email, verified, created_at, updated_at) VALUES (?, 'center@example.com', 1, ?, ?)").run(primaryEmailId, now, now);
	database.prepare('INSERT INTO passport_user_emails (user_id, email_id, is_primary, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(userId, primaryEmailId, now, now);
	database.prepare("INSERT INTO passport_devices (id, key, fingerprint, status, last_seen_at, created_at, updated_at) VALUES (41, ?, ?, 'active', ?, ?, ?)").run(deviceKey, fingerprintData, now, now, now);
	database.prepare("INSERT INTO passport_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (41, ?, 'active', ?, ?, ?)").run(userId, now, now, now);
	database.prepare('INSERT INTO passport_sessions (token_hash, user_id, device_id, expires_at, created_at, updated_at) VALUES (?, ?, 41, ?, ?, ?)').run(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId))).toString('hex'), userId, now + 3600_000, now, now);
	database.close();

	const request = (path, options = {}) => {
		const requestUrl = new URL(path, 'http://test');
		if (!options.method && requestUrl.pathname.startsWith('/api/panel/') && !requestUrl.searchParams.has('include')) requestUrl.searchParams.set('include', 'schema,data');
		return app.request(`http://accounts.test${requestUrl.pathname}${requestUrl.search}`, {
		method: options.method,
		headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData, ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	};

	// 没有 Accounts 会话时账户中心接口和导航都不可用。
	assert.equal((await request('/api/panel/accounts/profile.php')).status, 401);
	const anonymousDocument = await (await request('/', { headers: { accept: 'text/html' } })).text();
	assert.match(anonymousDocument, /示例账户中心/);
	const signedDocument = await (await request('/', { cookie, headers: { accept: 'text/html' } })).text();
	assert.match(signedDocument, /示例账户中心/);

	// 同时存在站点本地会话时，仍以 Accounts 昵称为准，两个中心入口和两套独立退出动作都给出。
	const localDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const localNow = Date.now();
	localDatabase.prepare("INSERT INTO base_users (id, name, password, roles, status, created_at, updated_at) VALUES (9, 'admin', '!local', '[\"admin\"]', 'enabled', ?, ?)").run(localNow, localNow);
	localDatabase.prepare("INSERT INTO base_devices (id, user_id, key, fingerprint, status, last_seen_at, created_at, updated_at) VALUES (42, 9, ?, ?, 'active', ?, ?, ?)").run(deviceKey, fingerprintData, localNow, localNow, localNow);
	localDatabase.prepare("INSERT INTO base_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (42, 9, 'active', ?, ?, ?)").run(localNow, localNow, localNow);
	localDatabase.prepare('INSERT INTO base_sessions (created_at, updated_at, token_hash, user_id, expires_at, device_id) VALUES (?, ?, ?, 9, ?, 42)').run(localNow, localNow, localSessionHash, localNow + 3600_000);
	localDatabase.close();
	const bothDocument = await (await request('/', { cookie: `${cookie}; base_session=${localSessionToken}`, headers: { accept: 'text/html' } })).text();
	assert.match(bothDocument, /示例账户中心/);

	// 概览。
	const overview = await (await request('/api/panel/accounts/overview.php', { cookie })).json();
	assert.deepEqual(overview.dashboard.statistics.map((item) => [item.key, item.value]), [['emails', 1], ['providers', 0], ['telegram', 0]]);
	assert.equal(overview.dashboard.recentRows.find((row) => row.key === 'username').value, 'center2026');
	assert.equal(overview.dashboard.recentRows.find((row) => row.key === 'password').value, '未设置');

	// 个人资料：用户名和昵称都可改，且沿用统一格式校验。
	const profile = await (await request('/api/panel/accounts/profile.php', { cookie })).json();
	assert.equal(profile.currentValues.username, 'center2026');
	assert.equal(profile.currentValues.primary_email, 'center@example.com');
	assert.equal(profile.formPage.fields.find((field) => field.name === 'username').readOnlyWhen, undefined);
	assert.equal((await request('/api/panel/accounts/profile.php', { method: 'PUT', cookie, body: { nickname: '  ' } })).status, 400);
	const savedProfile = await request('/api/panel/accounts/profile.php', { method: 'PUT', cookie, body: { username: 'center2027', nickname: '新昵称' } });
	assert.equal(savedProfile.status, 200);
	assert.deepEqual((await savedProfile.json()).currentValues, { locked: '1', username: 'center2027', nickname: '新昵称', primary_email: 'center@example.com' });

	// 邮箱管理提供绑定、设为主邮箱和解绑。
	const emailsPath = '/api/panel/accounts/emails.php';
	const initialEmails = await (await request(emailsPath, { cookie })).json();
	assert.deepEqual(initialEmails.table.dataSource.map((row) => [row.email, row.is_primary, row.verified]), [['center@example.com', '1', '1']]);
	assert.deepEqual(initialEmails.table.option.actions.toolbar.map((action) => action.key), ['bind-email']);
	assert.deepEqual(initialEmails.table.option.actions.row.map((action) => action.key), ['primary', 'delete']);

	// 绑定邮箱：没有第三方认证凭证时不允许发送验证码。
	const bindPath = '/api/panel/accounts/bind-email.php';
	const needVerify = await (await request(bindPath, { cookie })).json();
	assert.equal(needVerify.formPage.initialValues.step, 'check');
	assert.match(needVerify.formPage.description, /必须先完成一次第三方认证/);
	assert.equal((await request(bindPath, { method: 'POST', cookie, body: { step: 'send', email: 'second@example.com' } })).status, 403);
	assert.equal(deliveredCode, '', '未通过第三方认证不应该发出验证码');

	// 带上第三方认证凭证后才能发送验证码并绑定。
	const verifiedCookie = `${cookie}; accounts_external_verified=1`;
	const bindForm = await (await request(bindPath, { cookie: verifiedCookie })).json();
	assert.equal(bindForm.formPage.initialValues.step, 'send');
	assert.equal((await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'send', email: 'center@example.com' } })).status, 400);
	assert.equal((await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'send', email: 'not-an-email' } })).status, 400);
	const sent = await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'send', email: 'second@example.com' } });
	assert.equal(sent.status, 200);
	assert.equal((await sent.json()).formPage.initialValues.step, 'verify');
	assert.match(deliveredCode, /^\d{6}$/);
	const pendingEmails = await (await request(emailsPath, { cookie })).json();
	assert.deepEqual(pendingEmails.table.dataSource.map((row) => [row.email, row.verified]), [['center@example.com', '1'], ['second@example.com', '0']]);
	assert.equal((await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'verify', code: '000000' } })).status, 409);
	const bound = await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'verify', code: deliveredCode } });
	assert.equal(bound.status, 200);
	assert.equal((await bound.json()).formPage, undefined, '绑定完成后应结束弹窗流程并刷新列表');
	const boundEmails = await (await request(emailsPath, { cookie })).json();
	assert.deepEqual(boundEmails.table.dataSource.map((row) => [row.email, row.is_primary, row.verified]), [['center@example.com', '1', '1'], ['second@example.com', '0', '1']]);
	const secondEmailId = boundEmails.table.dataSource.find((row) => row.email === 'second@example.com').email_id;

	// 主邮箱不能解绑，切换主邮箱后旧主邮箱才可以解绑。
	assert.equal((await request(emailsPath, { method: 'DELETE', cookie, body: [primaryEmailId] })).status, 409);
	assert.equal((await request(`${emailsPath}/${secondEmailId}?action=primary`, { method: 'POST', cookie })).status, 200);
	const switched = await (await request(emailsPath, { cookie })).json();
	assert.deepEqual(switched.table.dataSource.map((row) => [row.email, row.is_primary]), [['second@example.com', '1'], ['center@example.com', '0']]);
	assert.equal((await request(emailsPath, { method: 'DELETE', cookie, body: [primaryEmailId] })).status, 200);
	assert.equal((await request(emailsPath, { method: 'DELETE', cookie, body: [secondEmailId] })).status, 409);

	// 身份绑定：列出第三方账号和 Telegram 账号，可以解绑第三方账号。
	const identitiesPath = '/api/panel/accounts/identities.php';
	const identityDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const identityNow = Date.now();
	identityDatabase.prepare("INSERT INTO passport_external_providers (provider,display_name,client_id,client_secret,status,created_at,updated_at) VALUES ('google','Google','g','s','enabled',?,?)").run(identityNow, identityNow);
	identityDatabase.prepare("INSERT INTO passport_external_identities (user_id,provider,subject,profile,created_at,updated_at) VALUES (?,'google','google-sub','{\"name\":\"Google用户\"}',?,?)").run(userId, identityNow, identityNow);
	identityDatabase.prepare("INSERT INTO global_telegram_bots (id,name,token,username,secret_token,webhook_hostname,status,created_at,updated_at) VALUES (7,'bot','7:token','center_bot','secret','accounts.test','enabled',?,?)").run(identityNow, identityNow);
	identityDatabase.close();

	// 只剩最后一个登录方式且没有密码时，不允许解绑。
	const lastIdentity = await request(identitiesPath, { method: 'DELETE', cookie, body: ['external:1'] });
	assert.equal(lastIdentity.status, 409);
	assert.match((await lastIdentity.json()).feedback.message, /最后一个登录方式/);

	const telegramDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	telegramDatabase.prepare("INSERT INTO passport_external_identities (user_id,provider,subject,profile,created_at,updated_at) VALUES (?,'wechat','wx-appid:o6fZopenid','{\"nickname\":\"微信用户\"}',?,?)").run(userId, identityNow, identityNow);
	telegramDatabase.prepare("INSERT INTO passport_external_providers (provider,display_name,client_id,client_secret,status,created_at,updated_at) VALUES ('wechat','微信','w','s','enabled',?,?)").run(identityNow, identityNow);
	telegramDatabase.prepare('INSERT INTO passport_telegram_accounts (id,user_id,bot_id,telegram_user_id,chat_id,nickname,created_at,updated_at) VALUES (77,?,7,9001,9001,\'TG用户\',?,?)').run(userId, identityNow, identityNow);
	telegramDatabase.close();
	const identities = await (await request(identitiesPath, { cookie })).json();
	assert.deepEqual(identities.table.dataSource.map((row) => row.provider_label), ['Google', '微信', 'Telegram']);
	assert.deepEqual(identities.table.dataSource.map((row) => row.nickname), ['Google用户', '微信用户', 'TG用户']);
	// 微信的 subject 是 appid:openid，列表只展示 openid。
	assert.equal(identities.table.dataSource[1].detail, 'o6fZopenid');
	assert.match(identities.table.dataSource[2].detail, /@center_bot \/ 9001/);
	assert.deepEqual(identities.table.option.actions.row.map((action) => action.key), ['delete']);
	assert.match(identities.table.option.actions.row[0].confirm, /\{provider_label\}.*\{detail\}/);

	// Telegram 账号要在机器人里解绑，这里给出明确提示。
	const telegramUnbind = await request(identitiesPath, { method: 'DELETE', cookie, body: ['telegram:77'] });
	assert.equal(telegramUnbind.status, 409);
	assert.match((await telegramUnbind.json()).feedback.message, /Telegram 机器人/);

	// 身份绑定列表直接提供可用的身份源，点击后跳转授权。
	assert.deepEqual(identities.table.option.actions.toolbar.map((action) => action.key), ['bind:google', 'bind:wechat']);
	const startBind = await request(`${identitiesPath}?action=bind:google`, { method: 'POST', cookie, body: {} });
	assert.equal((await startBind.json()).redirectTo, '/api/accounts/external/google');
	assert.ok(startBind.headers.getSetCookie().some((value) => value.startsWith('accounts_bind_return=')), '要记住返回账户中心的页面');

	// 安全设置：首次设置密码，然后需要当前密码才能修改。
	const security = await (await request('/api/panel/accounts/security.php', { cookie })).json();
	assert.deepEqual(security.formPage.fields.map((field) => field.name), ['password', 'password_confirm']);
	assert.equal((await request('/api/panel/accounts/security.php', { method: 'PUT', cookie, body: { password: 'center-password-1', password_confirm: 'other' } })).status, 400);
	assert.equal((await request('/api/panel/accounts/security.php', { method: 'PUT', cookie, body: { password: 'center-password-1', password_confirm: 'center-password-1' } })).status, 200);
	const secured = await (await request('/api/panel/accounts/security.php', { cookie })).json();
	assert.deepEqual(secured.formPage.fields.map((field) => field.name), ['current_password', 'password', 'password_confirm']);
	assert.equal((await request('/api/panel/accounts/security.php', { method: 'PUT', cookie, body: { current_password: 'wrong', password: 'center-password-2', password_confirm: 'center-password-2' } })).status, 401);
	assert.equal((await request('/api/panel/accounts/security.php', { method: 'PUT', cookie, body: { current_password: 'center-password-1', password: 'center-password-2', password_confirm: 'center-password-2' } })).status, 200);
	// 设置密码后才允许解绑最后一个第三方身份。
	const unbound = await request(identitiesPath, { method: 'DELETE', cookie, body: ['external:1'] });
	assert.equal(unbound.status, 200);
	assert.match((await unbound.json()).feedback.message, /Google 已解绑/);
	const afterUnbind = await (await request(identitiesPath, { cookie })).json();
	assert.deepEqual(afterUnbind.table.dataSource.map((row) => row.provider_label), ['微信', 'Telegram']);

	// 旧密码登录会被拒绝并提示新密码的修改时间。
	const oldPasswordLogin = await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'password', email: 'second@example.com', password: 'center-password-1' } });
	assert.equal(oldPasswordLogin.status, 401);
	assert.match((await oldPasswordLogin.json()).feedback.message, /密码已于.*修改/);
	const newPasswordLogin = await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'password', email: 'second@example.com', password: 'center-password-2' } });
	assert.equal(newPasswordLogin.status, 200);
	assert.equal((await newPasswordLogin.json()).redirectTo, '/panel/accounts.html');

	console.log('accounts center test passed');
} finally {
	globalThis.fetch = originalFetch;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
