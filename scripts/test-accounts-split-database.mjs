import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// 验证 global 与 passport 使用不同数据库时，Accounts 身份、账户中心和 OIDC 仍然可用。
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-accounts-split-'));
const globalFile = join(temporaryDirectory, 'default.sqlite');
const passportFile = join(temporaryDirectory, 'passport.sqlite');
process.env.DEFAULT_DATABASE_FILE = globalFile;
process.env.SKIP_SERVER_LISTEN = '1';
const originalFetch = globalThis.fetch;
let deliveredCode = '';
globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	if (url.href === 'https://dm.aliyuncs.com/') {
		const body = new URLSearchParams(String(init?.body ?? ''));
		deliveredCode = String(JSON.parse(body.get('Template')).TemplateData.code);
		return Response.json({ RequestId: 'split-email-request', EnvId: 'split-email-message' });
	}
	return originalFetch(input, init);
};

const userId = '1000000000000000007';
const emailId = '2000000000000000007';
const sessionId = 'accounts-split-session';
const cookie = `passport_session=${sessionId}`;
const deviceKey = '00000000-0000-4000-8000-000000000001';
const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });

try {
	// 第一次启动建立 global 结构并登记代码站点。
	await import(`../dist/server.mjs?accounts-split-boot=${Date.now()}`);
	const bootstrap = new DatabaseSync(globalFile);
	bootstrap.prepare("UPDATE global_sites SET dsn = ? WHERE key = 'passport'").run(`sqlite://${passportFile}`);
	bootstrap.close();

	// 第二次启动会把 passport 迁移到独立数据库文件。
	const { app } = await import(`../dist/server.mjs?accounts-split=${Date.now()}`);

	const globalDatabase = new DatabaseSync(globalFile);
	const now = Date.now();
	globalDatabase.prepare("INSERT INTO global_site_hosts (hostname, site_key, status, created_at) VALUES ('accounts.split.test', 'passport', 'enabled', ?)").run(now);
	globalDatabase.prepare(`INSERT INTO global_cloud_credentials (id, name, provider, access_key_id, access_key_secret, status, created_at, updated_at)
		VALUES (91, 'split-email', 'aliyun', 'mail-key', 'mail-secret', 'enabled', ?, ?)`).run(now, now);
	globalDatabase.prepare(`INSERT INTO global_cloud_email_channels (id, cloud_credential_id, region, account_name, from_alias, reply_to_address, status, created_at, updated_at)
		VALUES (92, 91, 'cn-hangzhou', 'noreply@example.com', 'Accounts', 0, 'enabled', ?, ?)`).run(now, now);
	globalDatabase.prepare(`INSERT INTO global_cloud_email_templates (id, key, type, name, subject, body_text, body_html, status, created_at, updated_at)
		VALUES (93, 'email_verification_split', 'email_verification', '分库邮箱验证码', '验证码 {{code}}', '验证码：{{code}}', '<p>验证码：{{code}}</p>', 'enabled', ?, ?)`).run(now, now);
	globalDatabase.prepare(`INSERT INTO global_cloud_email_template_publications (template_id, cloud_credential_id, region, provider_template_id, content_hash, status, created_at, updated_at)
		VALUES (93, 91, 'cn-hangzhou', 'split-template', 'test', 'ready', ?, ?)`).run(now, now);
	globalDatabase.prepare(`INSERT INTO global_cloud_email_bindings (site_key, channel_id, template_id, purpose, is_default, status, created_at, updated_at)
		VALUES ('passport', 92, 93, 'email_verification', 1, 'enabled', ?, ?)`).run(now, now);
	globalDatabase.close();

	const passportDatabase = new DatabaseSync(passportFile);
	passportDatabase.prepare("INSERT INTO passport_users (user_id, name, nickname, status, created_at, updated_at) VALUES (?, ?, '分库用户', 'enabled', ?, ?)").run(userId, `passport_${userId}`, now, now);
	passportDatabase.prepare("INSERT INTO passport_emails (id, email, verified, created_at, updated_at) VALUES (?, 'split@example.com', 1, ?, ?)").run(emailId, now, now);
	passportDatabase.prepare('INSERT INTO passport_user_emails (user_id, email_id, is_primary, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(userId, emailId, now, now);
	passportDatabase.prepare("INSERT INTO passport_devices (key,fingerprint,status,last_seen_at,created_at,updated_at) VALUES (?,?,'active',?,?,?)").run(deviceKey, fingerprintData, now, now, now);
	const deviceId = passportDatabase.prepare('SELECT id FROM passport_devices WHERE key = ?').get(deviceKey).id;
	passportDatabase.prepare("INSERT INTO passport_device_users (device_id,user_id,status,last_seen_at,created_at,updated_at) VALUES (?,?,'active',?,?,?)").run(deviceId, userId, now, now, now);
	passportDatabase.prepare('INSERT INTO passport_sessions (token_hash, user_id, device_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId))).toString('hex'), userId, deviceId, now + 3600_000, now, now);
	passportDatabase.close();

	const request = (path, options = {}) => {
		const requestUrl = new URL(path, 'http://test');
		if (!options.method && requestUrl.pathname.startsWith('/api/panel/') && !requestUrl.searchParams.has('include')) requestUrl.searchParams.set('include', 'schema,data');
		return app.request(`http://accounts.split.test${requestUrl.pathname}${requestUrl.search}`, {
		method: options.method,
		headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData, ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	};

	// 登录页读的是 passport 库里的邮箱：已注册但没设置过密码时不给密码框，直接引导第三方登录。
	const known = await (await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'email', email: 'split@example.com' } })).json();
	assert.equal(known.formPage.initialValues.step, 'restart');
	assert.match(known.formPage.description, /尚未设置密码/);
	assert.equal(known.formPage.fields.some((field) => field.name === 'password'), false);
	// 直接调用密码登录接口仍然会被挡住。
	const forced = await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'password', email: 'split@example.com', password: 'whatever' } });
	assert.equal(forced.status, 409);
	assert.match((await forced.json()).feedback.message, /尚未设置密码/);
	const unknown = await (await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'password', email: 'nobody@example.com', password: 'whatever' } })).json();
	assert.equal(unknown.formPage.initialValues.step, 'email_confirm');

	// 用户名校验和补全流程只依赖 passport 库。
	const onboarding = await (await request('/api/accounts/sign.php', { cookie })).json();
	assert.equal(onboarding.formPage.initialValues.step, 'set_username');
	assert.equal((await request('/api/accounts/sign.php', { method: 'POST', cookie, body: { step: 'set_username', username: 'Split2026' } })).status, 400);
	assert.equal((await request('/api/accounts/sign.php', { method: 'POST', cookie, body: { step: 'set_username', username: 'split2026' } })).status, 200);
	// 身份数据落在 passport 库，global 库不参与。
	const splitPassport = new DatabaseSync(passportFile, { readOnly: true });
	assert.equal(splitPassport.prepare('SELECT name FROM passport_users WHERE user_id = ?').get(userId).name, 'split2026');
	splitPassport.close();
	const splitGlobal = new DatabaseSync(globalFile, { readOnly: true });
	assert.equal(splitGlobal.prepare('SELECT COUNT(*) AS count FROM passport_users').get().count, 0, '身份不应该写进 global 库');
	splitGlobal.close();

	// 账户中心：邮件模板和云凭据来自 global 库，验证码和绑定写在 passport 库。
	const emailsPath = '/api/panel/accounts/emails.php';
	const bindPath = '/api/panel/accounts/bind-email.php';
	const verifiedCookie = `${cookie}; accounts_external_verified=1`;
	assert.equal((await request(bindPath, { method: 'POST', cookie, body: { step: 'send', email: 'split-second@example.com' } })).status, 403);
	assert.equal((await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'send', email: 'split-second@example.com' } })).status, 200);
	assert.match(deliveredCode, /^\d{6}$/);
	const otpDatabase = new DatabaseSync(passportFile, { readOnly: true });
	assert.equal(otpDatabase.prepare("SELECT COUNT(*) AS count FROM passport_user_email_otps WHERE status = 'pending'").get().count, 1);
	otpDatabase.close();
	assert.equal((await request(bindPath, { method: 'POST', cookie: verifiedCookie, body: { step: 'verify', code: deliveredCode } })).status, 200);
	const boundEmails = await (await request(emailsPath, { cookie })).json();
	assert.deepEqual(boundEmails.table.dataSource.map((row) => row.email), ['split@example.com', 'split-second@example.com']);

	// 概览与个人资料同样只读 passport 库。
	const overview = await (await request('/api/panel/accounts/overview.php', { cookie })).json();
	assert.equal(overview.dashboard.recentRows.find((row) => row.key === 'username').value, 'split2026');
	assert.equal(overview.dashboard.statistics.find((item) => item.key === 'emails').value, 2);

	// 设置密码后可以直接用邮箱密码登录。
	assert.equal((await request('/api/panel/accounts/security.php', { method: 'PUT', cookie, body: { password: 'split-password-1', password_confirm: 'split-password-1' } })).status, 200);
	// 设置密码后，同一个邮箱走到的就是密码登录表单了。
	const withPassword = await (await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'email', email: 'split@example.com' } })).json();
	assert.equal(withPassword.formPage.initialValues.step, 'password');
	const passwordLogin = await request('/api/accounts/sign.php', { method: 'POST', body: { step: 'password', email: 'split@example.com', password: 'split-password-1' } });
	assert.equal(passwordLogin.status, 200);
	assert.equal((await passwordLogin.json()).redirectTo, '/panel/accounts.html');

	console.log('accounts split database test passed');
} finally {
	globalThis.fetch = originalFetch;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
