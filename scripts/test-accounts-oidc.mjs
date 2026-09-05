import assert from 'node:assert/strict';
import { readPageContext } from './page-context.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-accounts-oidc-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

const base64Url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
/** 与 server/modules/base/auth/index.mts 的 hashPassword 同格式，用来直接造出可校验的凭证行。 */
const storedPassword = async (password) => {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer, iterations: 210_000 }, material, 256));
	return JSON.stringify({ hash: `pbkdf2-sha256$210000$${toBase64(salt)}$${toBase64(bits)}`, pattern: 'L'.repeat(password.length) });
};
const originalFetch = globalThis.fetch;

try {
	const { app } = await import(`../dist/server.mjs?accounts-oidc=${Date.now()}`);
	globalThis.fetch = (input, init) => {
		const url = new URL(String(input));
		return ['accounts.test', 'site1.test'].includes(url.hostname) ? app.request(url.toString(), init) : originalFetch(input, init);
	};
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now(), userId = 1000000000000000000n, deviceKey = '00000000-0000-4000-8000-000000000001', fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' }), sessionId = crypto.randomUUID(), sessionToken = crypto.randomUUID();
	const sessionHash = base64Url(await sha256(sessionToken));
	const passportSessionHash = Buffer.from(await sha256(sessionId)).toString('hex');
	database.prepare(`INSERT INTO global_site_hosts (hostname, site_key, status, created_at) VALUES ('accounts.test', 'passport', 'enabled', ?)`).run(now);
	database.prepare(`INSERT INTO global_sites (key, name, base_site_key, dsn, database_binding, status, migration_status, is_default, is_system)
		VALUES ('site1', 'Business Site', 'base', '', '', 'enabled', 'ready', 0, 0)`).run();
	database.prepare(`INSERT INTO global_site_hosts (hostname, site_key, status, created_at) VALUES ('site1.test', 'site1', 'enabled', ?)`).run(now);
	database.prepare(`INSERT INTO passport_users (user_id, name, status, created_at, updated_at) VALUES (?, ?, 'enabled', ?, ?)`).run(userId, `passport_${userId}`, now, now)
	database.prepare(`INSERT INTO passport_user_profiles (user_id, nickname, created_at, updated_at) VALUES (?, 'AccountsUser', 0, 0)`).run(userId);
	database.prepare(`INSERT INTO passport_devices (user_agent, platform, ip_address, key, fingerprint, status, last_seen_at, created_at, updated_at) VALUES ('Test Browser', 'test', '127.0.0.1', ?, ?, 'active', ?, ?, ?)`).run(deviceKey, fingerprintData, now, now, now);
	const deviceId = String(database.prepare('SELECT id FROM passport_devices WHERE key = ?').get(deviceKey).id);
	database.prepare(`INSERT INTO passport_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)`).run(deviceId, userId, now, now, now);
	database.prepare(`INSERT INTO passport_sessions (token_hash, user_id, expires_at, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(passportSessionHash, userId, now + 3600_000, deviceId, now, now);
	// 第二个 Accounts 身份验证「绑定到本站已有账号」，第三个验证「建号时拷贝密码」。
	const secondUserId = 1000000000000000001n, secondSessionId = crypto.randomUUID();
	const thirdUserId = 1000000000000000002n, thirdSessionId = crypto.randomUUID();
	const thirdUserPassword = await storedPassword('createpassword');
	database.prepare(`INSERT INTO passport_users (user_id, name, status, created_at, updated_at) VALUES (?, 'createuser', 'enabled', ?, ?)`).run(thirdUserId, now, now);
	database.prepare('INSERT INTO passport_user_credentials (user_id, password, created_at, updated_at) VALUES (?, ?, ?, ?)').run(thirdUserId, thirdUserPassword, now, now);
	const secondSessionHash = Buffer.from(await sha256(secondSessionId)).toString('hex');
	database.prepare(`INSERT INTO passport_users (user_id, name, status, created_at, updated_at) VALUES (?, 'binduser', 'enabled', ?, ?)`).run(secondUserId, now, now);
	database.prepare(`INSERT INTO passport_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)`).run(deviceId, secondUserId, now, now, now);
	database.prepare(`INSERT INTO passport_sessions (token_hash, user_id, expires_at, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(secondSessionHash, secondUserId, now + 3600_000, deviceId, now, now);
	database.prepare(`INSERT INTO passport_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)`).run(deviceId, thirdUserId, now, now, now);
	database.prepare(`INSERT INTO passport_sessions (token_hash, user_id, expires_at, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(Buffer.from(await sha256(thirdSessionId)).toString('hex'), thirdUserId, now + 3600_000, deviceId, now, now);
	const clientId = 'acct_test', clientSecret = 'test-client-secret', verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
	const secretHash = Buffer.from(await sha256(clientSecret)).toString('hex'), challenge = base64Url(await sha256(verifier));
	database.prepare(`INSERT INTO passport_oidc_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes, require_pkce, status, created_at, updated_at, backchannel_logout_uri)
		VALUES (?, 'Test Client', ?, '["https://client.test/callback","https://site1.test/api/accounts/oidc/callback"]', 'openid profile email', 1, 'enabled', ?, ?, 'https://site1.test/api/accounts/oidc/backchannel-logout')`).run(clientId, secretHash, now, now);
	database.prepare(`INSERT INTO base_configs (created_at, updated_at, key, value) VALUES (?, ?, 'accounts-oidc-client', ?)`).run(now, now, JSON.stringify({ enabled: true, issuer: 'https://accounts.test', clientId, clientSecret }));
	// 密码同步两侧都要开：Accounts 客户端的「下发密码」+ 本站的「同步 Accounts 密码」。
	// 站点设置随请求配置一起缓存，必须在第一次请求之前写进去。
	database.prepare(`INSERT INTO base_configs (created_at, updated_at, key, value) VALUES (?, ?, 'site-settings', ?)`).run(now, now, JSON.stringify({ passwordSyncEnabled: true }));
	const bindUserPassword = await storedPassword('accountspassword');
	database.prepare('INSERT INTO passport_user_credentials (user_id, password, created_at, updated_at) VALUES (?, ?, ?, ?)').run(secondUserId, bindUserPassword, now, now);

	database.prepare(`INSERT INTO base_users (id, name, roles, status, created_at, updated_at) VALUES (77, 'localadmin', '["admin"]', 'enabled', ?, ?)`).run(now, now);
	// 绑定路径的目标账号：本站已有、且**有本地密码**。localadmin 故意不给密码，用来验证
	// 「没有本地密码的账号绑不上」——那种账号本来就没有密码可以用来证明所有权。
	database.prepare(`INSERT INTO base_users (id, name, roles, status, created_at, updated_at) VALUES (78, 'bindtarget', '[]', 'enabled', ?, ?)`).run(now, now);
	const bindTargetPassword = await storedPassword('bindpassword');
	database.prepare('INSERT INTO base_user_credentials (user_id, password, created_at, updated_at) VALUES (78, ?, ?, ?)').run(bindTargetPassword, now, now);
	database.prepare(`INSERT INTO base_devices (id, user_id, key, fingerprint, status, last_seen_at, created_at, updated_at) VALUES (42, 77, ?, ?, 'active', ?, ?, ?)`).run(deviceKey, fingerprintData, now, now, now);
	database.prepare(`INSERT INTO base_device_users (device_id, user_id, status, last_seen_at, created_at, updated_at) VALUES (42, 77, 'active', ?, ?, ?)`).run(now, now, now);
	database.prepare(`INSERT INTO base_sessions (created_at, updated_at, token_hash, user_id, expires_at, device_id) VALUES (?, ?, ?, 77, ?, 42)`).run(now, now, sessionHash, now + 3600_000);
	database.close();
	const request = (path, options = {}) => {
		const headers = new Headers(options.headers);
		if (!headers.has('x-device-key')) headers.set('x-device-key', deviceKey);
		if (!headers.has('x-device-fingerprint')) headers.set('x-device-fingerprint', fingerprintData);
		return app.request(`https://accounts.test${path}`, { method: options.method, headers, body: options.body });
	};
	const discovery = await (await request('/.well-known/openid-configuration')).json();
	assert.equal(discovery.issuer, 'https://accounts.test');
	assert.equal(discovery.authorization_endpoint, 'https://accounts.test/api/oidc/authorize');
	const forwardedDiscovery = await (await app.request('http://accounts.test/.well-known/openid-configuration', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'accounts.test' } })).json();
	assert.equal(forwardedDiscovery.issuer, 'https://accounts.test');
	const authorize = new URL('/api/oidc/authorize', 'https://accounts.test');
	authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.test/callback', scope: 'openid profile', state: 'state-1', nonce: 'nonce-1', code_challenge: challenge, code_challenge_method: 'S256' }).toString();
	// 还没有设置用户名的账号即使已登录，也要先回登录页补全，不发授权码。
	const blocked = await request(`${authorize.pathname}${authorize.search}`, { headers: { cookie: `passport_session=${sessionId}` } });
	assert.equal(blocked.status, 302);
	assert.match(blocked.headers.get('location'), /\/accounts\/sign(?:\.html)?(?:\?|$)/);
	// 从业务站点跳来登录时，登录页要说明来源并提供返回入口，避免用户回不去。
	const oidcRequestCookie = blocked.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value.startsWith('accounts_oidc_request='));
	assert.ok(oidcRequestCookie);
	const fromClient = await (await request('/api/accounts/sign.php', { headers: { cookie: oidcRequestCookie } })).json();
	assert.match(fromClient.formPage.description, /正在为 client\.test 登录 Accounts/);
	assert.deepEqual(fromClient.formPage.actions.map((action) => action.key), ['return_to_client']);
	assert.equal(fromClient.formPage.actions[0].label, '取消登录');
	const returned = await request('/api/accounts/sign.php?action=return_to_client', { method: 'POST', headers: { cookie: oidcRequestCookie, 'content-type': 'application/json' }, body: '{}' });
	const cancelled = await returned.json();
	// 弹窗里取消登录先关窗口，非弹窗场景才回落到来源站点。
	assert.equal(cancelled.closeWindow, true);
	assert.equal(cancelled.redirectTo, 'https://client.test');
	assert.ok(returned.headers.getSetCookie().some((value) => value.startsWith('accounts_oidc_request=;')));

	const userNameDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	userNameDatabase.prepare('UPDATE passport_users SET name = ? WHERE user_id = ?').run('oidcuser1', String(userId));
	userNameDatabase.prepare('INSERT INTO passport_user_credentials (user_id, password, created_at, updated_at) VALUES (?, ?, ?, ?)').run(String(userId), 'test-password-hash', Date.now(), Date.now());
	userNameDatabase.close();
	const authorized = await request(`${authorize.pathname}${authorize.search}`, { headers: { cookie: `passport_session=${sessionId}` } });
	assert.equal(authorized.status, 302);
	const callback = new URL(authorized.headers.get('location'));
	assert.equal(callback.origin, 'https://client.test'); assert.equal(callback.searchParams.get('state'), 'state-1');
	const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: 'https://client.test/callback', client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
	const tokenResponse = await request('/api/oidc/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody.toString() });
	assert.equal(tokenResponse.status, 200);
	const tokens = await tokenResponse.json(); assert.match(tokens.id_token, /^[^.]+\.[^.]+\.[^.]+$/); assert.equal(tokens.token_type, 'Bearer');
	const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
	assert.equal(claims.iss, 'https://accounts.test'); assert.equal(claims.aud, clientId); assert.equal(claims.sub, String(userId)); assert.equal(claims.nonce, 'nonce-1');
	// 密码同步默认关闭：客户端没打开「下发密码」时，ID Token 里不带凭证 claim。
	const credentialClaim = 'https://quick-react.dev/claims/credential';
	assert.equal(claims[credentialClaim], undefined, '默认不下发凭证');
	const userinfo = await (await request('/api/oidc/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
	assert.equal(userinfo.sub, String(userId)); assert.equal(userinfo.name, 'AccountsUser');
	assert.equal((await request('/api/oidc/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody.toString() })).status, 400);
	const jwks = await (await request('/api/oidc/jwks')).json(); assert.equal(jwks.keys[0].alg, 'RS256'); assert.ok(jwks.keys[0].n);
	// Passport 站点自身也通过和业务站点相同的 Base OIDC 客户端登录。
	const passportSign = await (await request('/api/sign.php')).json();
	assert.deepEqual(passportSign.formPage.fields.map((field) => field.name), ['action']);
	const selfStart = await request('/api/sign.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const selfLoginCookie = selfStart.headers.get('set-cookie')?.split(';')[0];
	const selfAuthorizeUrl = (await selfStart.json()).redirectTo;
	const selfAuthorized = await app.request(selfAuthorizeUrl, { headers: { cookie: `passport_session=${sessionId}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	const selfCallbackResponse = await app.request(selfAuthorized.headers.get('location'), { headers: { cookie: selfLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(selfCallbackResponse.status, 200);
	// 首次用这个 Accounts 身份登录本站：回调不建号、也不建会话，把主窗口送去选择页。
	assert.equal(selfCallbackResponse.headers.getSetCookie().some((item) => item.startsWith('base_session=')), false, '还没选择就不该有会话');
	assert.match(await selfCallbackResponse.clone().text(), /\/accounts\/oidc\/bind\.html/);
	const bindPath = '/api/accounts/oidc/bind.php';
	const choice = await (await request(bindPath, { headers: { cookie: selfLoginCookie } })).json();
	// 上段建号、下段绑定，各自一个提交按钮；带过来的用户名两段都预填好。
	assert.deepEqual(choice.formPage.sections.map((section) => section.key), ['create', 'bind']);
	assert.equal(choice.formPage.sections[1].divider, '或');
	assert.deepEqual(choice.formPage.sections.map((section) => section.fields.map((field) => field.name)), [['user_name'], ['user_name', 'password']]);
	assert.equal(choice.formPage.initialValues.user_name, 'oidcuser1');
	const selfBind = (body) => app.request(`https://accounts.test${bindPath}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: selfLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData }, body: JSON.stringify(body) });
	assert.equal((await selfBind({ _section: 'create', user_name: 'localadmin' })).status, 409, '用户名被占用要明说，好让用户改一个');
	assert.equal((await selfBind({ _section: 'create', user_name: 'AB' })).status, 400, '不合规的用户名要拦下');
	// 这个客户端还没打开「下发密码」，所以没有密码可拷：建号那一段不出提示，
	// 建完之后再问一次密码，允许跳过。
	assert.equal(choice.formPage.sections[0].submitHint, undefined, '没有可拷的密码就不提示');
	const createdAccount = await selfBind({ _section: 'create', user_name: 'oidcuser1' });
	assert.equal(createdAccount.status, 200);
	const createdResult = await createdAccount.clone().json();
	assert.equal(createdResult.next, undefined, '没有密码可拷时先别跳走');
	assert.deepEqual(createdResult.formPage.fields.map((field) => field.name), ['return_path', 'newPassword']);
	assert.deepEqual(createdResult.formPage.actions.map((action) => action.key), ['skip_password'], '这一步可以跳过');
	const selfSessionCookie = createdAccount.headers.getSetCookie().find((item) => item.startsWith('base_session='))?.split(';')[0];
	assert.ok(selfSessionCookie);
	// 跳过之后照常回原页面；账号仍然没有本地密码，之后在个人中心可以补。
	const skipped = await app.request(`https://accounts.test${bindPath}?action=skip_password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: selfSessionCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData }, body: JSON.stringify({ return_path: '/' }) });
	assert.equal(skipped.status, 200);
	assert.deepEqual((await skipped.json()).next, { action: 'navigate', path: '/', refreshAuth: true });
	const skippedDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(skippedDatabase.prepare("SELECT COUNT(*) AS count FROM base_user_credentials c JOIN base_users u ON u.id = c.user_id WHERE u.name = 'oidcuser1'").get().count, 0, '跳过就是真的不设密码');
	skippedDatabase.close();
	// 落定后再进选择页：没登录就是「重新登录」，登录了但还没设密码就把补设那一页再给一次，
	// 否则刷新一下就成了死路。
	assert.equal((await app.request(`https://accounts.test${bindPath}`, { headers: { cookie: selfLoginCookie } })).status, 410);
	const reloaded = await app.request(`https://accounts.test${bindPath}`, { headers: { cookie: selfSessionCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(reloaded.status, 200);
	assert.deepEqual((await reloaded.json()).formPage.actions.map((action) => action.key), ['skip_password']);
	const signedInPassport = await (await request('/api/sign.php', { headers: { cookie: selfSessionCookie } })).json();
	assert.equal(signedInPassport.user.user_name, 'oidcuser1');
	const settled = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(settled.prepare('SELECT COUNT(*) AS count FROM base_oidc_login_requests').get().count, 0, '落定后待决请求要删掉');
	assert.equal(settled.prepare("SELECT COUNT(*) AS count FROM base_users WHERE name LIKE 'passport\\_%' ESCAPE '\\'").get().count, 0, '不再有占位用户名');
	settled.close();
	const signedInAccounts = await (await request('/api/accounts/sign.php', { headers: { cookie: `passport_session=${sessionId}` } })).json();
	assert.deepEqual(signedInAccounts.formPage.actions.map((action) => action.key), ['account_center', 'bind_identity', 'logout']);
	const accountCenter = await request('/api/accounts/sign.php?action=account_center', { method: 'POST', headers: { cookie: `passport_session=${sessionId}`, 'content-type': 'application/json' }, body: '{}' });
	assert.equal((await accountCenter.json()).next.path, '/panel/accounts.html');
	const strictDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	strictDatabase.prepare('UPDATE passport_oidc_clients SET strict_redirect_uri = 1 WHERE client_id = ?').run(clientId);
	const strictStart = await request('/api/sign.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const strictAuthorize = await app.request((await strictStart.json()).redirectTo, { headers: { cookie: `passport_session=${sessionId}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(strictAuthorize.status, 400);
	const strictMessage = (await strictAuthorize.json()).feedback.message;
	assert.match(strictMessage, /redirect_uri 未注册/);
	assert.match(strictMessage, /实际请求为 https:\/\/accounts\.test\/api\/accounts\/oidc\/callback/);
	assert.match(strictMessage, /允许地址为 https:\/\/client\.test\/callback/);
	strictDatabase.prepare('UPDATE passport_oidc_clients SET strict_redirect_uri = 0 WHERE client_id = ?').run(clientId);
	strictDatabase.close();
	const invalidAuthorize = new URL(authorize); invalidAuthorize.searchParams.set('redirect_uri', 'https://invalid.test/callback');
	const invalidResponse = await request(`${invalidAuthorize.pathname}${invalidAuthorize.search}`, { headers: { cookie: `passport_session=${sessionId}` } });
	const invalidMessage = (await invalidResponse.json()).feedback.message;
	assert.equal(invalidResponse.status, 400);
	assert.equal(invalidMessage.match(/https:\/\/site1\.test\/api\/accounts\/oidc\/callback/g)?.length, 1, '手工地址与自动地址重合时只显示一次');
	// 启用 Accounts 登录的业务站点：需要登录的页面直接弹窗，不再跳登录页，也不给本地注册入口。
	// API 页面启动（CDN 模式）下 auth 与 pageStatus 不嵌在文档里，与客户端一样从上下文接口取。
	const businessInitial = (await readPageContext(app, 'https://site1.test', '/panel/admin/base/users.html')).context;
	assert.deepEqual(businessInitial.auth.actions.map((action) => [action.key, action.action]), [['/sign', 'accounts-login']]);
	assert.equal(businessInitial.pageStatus.status, 401);
	assert.deepEqual(businessInitial.pageStatus.actions.map((action) => [action.label, action.action]), [['登录', 'accounts-login'], ['返回首页', 'navigate']]);
	const businessSign = await (await app.request('https://site1.test/api/sign.php')).json();
	assert.equal(businessSign.formPage.fields[0].name, 'action');
	const enabledLocalSession = await (await app.request('https://site1.test/api/sign.php', { headers: { cookie: `base_session=${sessionToken}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	assert.equal(enabledLocalSession.user, null);
	const modeDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	modeDatabase.prepare(`UPDATE base_configs SET value = ? WHERE key = 'accounts-oidc-client'`).run(JSON.stringify({ enabled: false, issuer: 'https://accounts.test', clientId, clientSecret }));
	const disabledLocalSession = await (await app.request('https://site1.test/api/sign.php', { headers: { cookie: `base_session=${sessionToken}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	assert.equal(disabledLocalSession.user.user_name, 'localadmin');
	assert.equal(disabledLocalSession.formPage.fields[0].name, 'user_name');
	modeDatabase.prepare(`UPDATE base_configs SET value = ? WHERE key = 'accounts-oidc-client'`).run(JSON.stringify({ enabled: true, issuer: 'https://accounts.test', clientId, clientSecret }));
	modeDatabase.close();
	// 业务站点不允许自动跳转到 Accounts，必须由用户点击按钮确认。
	// 只保留弹窗登录：既不自动跳转，也不整页跳走。
	assert.deepEqual(businessSign.formPage.passportLogin, { enabled: true });
	assert.match(businessSign.formPage.description, /本页不会自动跳转/);
	const businessStart = await app.request('https://site1.test/api/sign.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const loginCookie = businessStart.headers.get('set-cookie')?.split(';')[0];
	const businessAuthorizeUrl = (await businessStart.json()).redirectTo;
	const businessAuthorized = await app.request(businessAuthorizeUrl, { headers: { cookie: `passport_session=${sessionId}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	const businessCallback = businessAuthorized.headers.get('location');
	const businessCallbackResponse = await app.request(businessCallback, { headers: { cookie: loginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	// 弹窗回调直接返回关闭窗口的页面，不再中转到 /accounts/oidc/popup。
	assert.equal(businessCallbackResponse.status, 200);
	const popupBody = await businessCallbackResponse.clone().text();
	assert.match(popupBody, /postMessage/);
	assert.match(popupBody, /next:\{action:'navigate',path:.*refreshAuth:true\}/);
	assert.equal(popupBody.includes('/accounts/oidc/popup'), false);
	// 业务站点与身份中心同库同租户，映射是同一条：这已经不是首次登录，回调直接建会话。
	const businessSessionCookie = businessCallbackResponse.headers.getSetCookie().find((item) => item.startsWith('base_session='))?.split(';')[0];
	assert.ok(businessSessionCookie);
	assert.match(businessSessionCookie, /^base_session=.+/);
	const signedInBusiness = await (await app.request('https://site1.test/api/sign.php', { headers: { cookie: businessSessionCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	// Accounts 用户名通过 preferred_username 下发，业务站点用它替换 passport_<user_id> 占位名。
	assert.equal(claims.preferred_username, 'oidcuser1');
	assert.equal(signedInBusiness.user.user_name, 'oidcuser1');
	// 昵称走 name claim，和用户名是两套规则：本站昵称为空才补，人工设过的不覆盖。
	assert.equal(claims.name, 'AccountsUser');
	const syncedProfile = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(syncedProfile.prepare('SELECT nickname FROM base_user_profiles p JOIN base_users u ON u.id = p.user_id WHERE u.name = ?').get('oidcuser1').nickname, 'AccountsUser');
	syncedProfile.close();
	assert.deepEqual(signedInBusiness.formPage.passportLogin, { enabled: true });
	const signedInAuth = await (await app.request('https://site1.test/api/home.php?include=auth&path=%2Fpanel%2Fadmin%2Fbase%2Fusers', { headers: { cookie: businessSessionCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	assert.ok(signedInAuth.context);
	assert.equal(signedInAuth.context.auth.currentUser.user_name, 'oidcuser1');
	assert.ok(Array.isArray(signedInAuth.context.siteNavigation));
	assert.equal((await app.request('https://site1.test/api/auth.php')).status, 404, '认证上下文应由通用 API 响应层提供');
	const businessUsers = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(businessUsers.prepare("SELECT COUNT(*) AS count FROM base_users WHERE name LIKE 'passport\\_%' ESCAPE '\\'").get().count, 0);
	businessUsers.close();
	const completed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(completed.prepare('SELECT COUNT(*) AS count FROM base_oidc_users').get().count, 1); completed.close();
	// —— 另一个 Accounts 身份：绑定到本站已有账号 ——
	// 到这里才打开客户端的「下发密码」：上面那条「默认不下发凭证」的断言依赖它是关的。
	const syncDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	syncDatabase.prepare('UPDATE passport_oidc_clients SET password_sync = 1 WHERE client_id = ?').run(clientId);
	syncDatabase.close();
	// 这条路不建号：验证密码证明「这个本站账号确实是我的」，然后把身份映射指过去，角色不变。
	const bindStart = await app.request('https://site1.test/api/sign.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const bindLoginCookie = bindStart.headers.get('set-cookie')?.split(';')[0];
	const bindAuthorized = await app.request((await bindStart.json()).redirectTo, { headers: { cookie: `passport_session=${secondSessionId}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	const bindCallback = await app.request(bindAuthorized.headers.get('location'), { headers: { cookie: bindLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(bindCallback.headers.getSetCookie().some((item) => item.startsWith('base_session=')), false, '首次登录先选择，不直接建会话');
	const bindPost = (body) => app.request('https://site1.test/api/accounts/oidc/bind.php', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bindLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData }, body: JSON.stringify(body) });
	// 密码错、账号不存在、账号没有本地密码，一律同一句话——区分开来就成了账号探测器。
	for (const attempt of [{ user_name: 'bindtarget', password: 'wrong-password' }, { user_name: 'nobody', password: 'bindpassword' }, { user_name: 'localadmin', password: 'bindpassword' }]) {
		const rejected = await bindPost({ _section: 'bind', ...attempt });
		assert.equal(rejected.status, 401, `${attempt.user_name} 应该被拒绝`);
		assert.match((await rejected.json()).feedback.message, /用户名或密码错误/);
	}
	// 已经绑过一个 Accounts 身份的账号不能再绑第二个。
	assert.equal((await bindPost({ _section: 'bind', user_name: 'oidcuser1', password: 'bindpassword' })).status, 401);
	const boundResult = await bindPost({ _section: 'bind', user_name: 'bindtarget', password: 'bindpassword' });
	assert.equal(boundResult.status, 200);
	const boundCookie = boundResult.headers.getSetCookie().find((item) => item.startsWith('base_session='))?.split(';')[0];
	assert.ok(boundCookie);
	const boundSign = await (await app.request('https://site1.test/api/sign.php', { headers: { cookie: boundCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	// 绑定保留本站账号自己的用户名：Accounts 那边叫 binduser，本站还是 bindtarget。
	assert.equal(boundSign.user.user_name, 'bindtarget');
	// **绑定路径不碰密码**：用户刚用本站密码证明了所有权，把它换成 Accounts 的
	// 等于替他改了密码。绑定后本站密码保持原样。
	const syncedCredential = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(syncedCredential.prepare('SELECT password FROM base_user_credentials WHERE user_id = 78').get().password, bindTargetPassword, '绑定不该改掉本站密码');
	// 凭证 blob 只在待决期间存在，落定时随请求行一起删掉；库里不该再留下任何一份。
	assert.equal(syncedCredential.prepare("SELECT COUNT(*) AS count FROM base_oidc_login_requests WHERE status = 'choosing' OR credential != ''").get().count, 0);
	syncedCredential.close();
	const boundDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(boundDatabase.prepare('SELECT user_id FROM base_oidc_users WHERE subject = ?').get(String(secondUserId)).user_id, 78);
	assert.equal(boundDatabase.prepare('SELECT COUNT(*) AS count FROM base_users').get().count, 3, '绑定不该建出新账号（localadmin、bindtarget、oidcuser1）');
	boundDatabase.close();

	// —— 第三个 Accounts 身份：建号路径会把密码整块拷过来 ——
	const createStart = await app.request('https://site1.test/api/sign.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const createLoginCookie = createStart.headers.get('set-cookie')?.split(';')[0];
	const createAuthorized = await app.request((await createStart.json()).redirectTo, { headers: { cookie: `passport_session=${thirdSessionId}`, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	await app.request(createAuthorized.headers.get('location'), { headers: { cookie: createLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	const createChoice = await (await app.request('https://site1.test/api/accounts/oidc/bind.php', { headers: { cookie: createLoginCookie } })).json();
	// Accounts 那边设过密码，所以建号那一段在按钮上方讲清「本站密码就是它」。
	assert.match(createChoice.formPage.sections[0].submitHint, /Accounts 设置的那个密码/);
	const createdLocal = await app.request('https://site1.test/api/accounts/oidc/bind.php', { method: 'POST', headers: { 'content-type': 'application/json', cookie: createLoginCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData }, body: JSON.stringify({ _section: 'create', user_name: 'createlocal' }) });
	assert.equal(createdLocal.status, 200);
	// 有密码可拷就不再多问一步，直接回原页面。
	assert.deepEqual((await createdLocal.json()).next, { action: 'navigate', path: '/', refreshAuth: true });
	const copied = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(copied.prepare("SELECT c.password AS password FROM base_user_credentials c JOIN base_users u ON u.id = c.user_id WHERE u.name = 'createlocal'").get().password, thirdUserPassword, '整个 password blob 原样拷过来');
	copied.close();

	const logoutStart = await app.request('https://site1.test/api/sign.php', { method: 'DELETE', headers: { cookie: businessSessionCookie, referer: 'https://site1.test/panel/admin/base/users.html', 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	const logoutResult = await logoutStart.json();
	assert.equal(logoutStart.status, 200);
	assert.equal(logoutResult.redirectTo, undefined);
	assert.equal(logoutResult.logoutUrl, undefined);
	assert.deepEqual(logoutResult.next, { action: 'navigate', path: '/panel/admin/base/users.html', refreshAuth: true });
	const revoked = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(revoked.prepare('SELECT COUNT(*) AS count FROM passport_sessions WHERE token_hash = ?').get(passportSessionHash).count, 0);
	revoked.close();
	const afterGlobalLogout = await (await app.request('https://site1.test/api/sign.php', { headers: { cookie: businessSessionCookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).json();
	assert.equal(afterGlobalLogout.user, null);
	console.log('accounts oidc test passed');
} finally {
	globalThis.fetch = originalFetch;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
