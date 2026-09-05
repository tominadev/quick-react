import assert from 'node:assert/strict';
import { readPageContext } from './page-context.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// 未启用 Accounts 登录的站点，任何入口都不得走 Accounts 验证。
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-login-disabled-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?login-disabled=${Date.now()}`);
const deviceKey = '00000000-0000-4000-8000-000000000001';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = (path, options = {}) => app.request(`http://localhost${path}`, {
		method: options.method,
		headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	// API 页面启动（CDN 模式）下 auth、siteNavigation、pageStatus 不嵌在文档里，从上下文接口取。
	const initialData = async (path) => (await readPageContext(app, 'localhost', path, { headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).context;

	// 头部登录按钮在当前页弹出本站账号密码表单，不走 Accounts 登录窗口。
	const home = await initialData('/');
	assert.deepEqual(home.auth.actions.map((action) => [action.key, action.action]), [['/sign', 'local-login'], ['/sign-up', 'navigate']]);

	// 需要登录的页面提示同样弹出本站账号密码表单。
	const blocked = await initialData('/panel/admin/global/dashboard.html');
	assert.equal(blocked.pageStatus.status, 401);
	assert.deepEqual(blocked.pageStatus.actions.map((action) => action.action), ['local-login', 'navigate']);

	// 公开登录页已经取消，直接访问旧地址得到确定的 404；登录 API 仍供弹窗使用。
	// CDN 模式下文档一律 200（可缓存的壳），页面状态由上下文下发、客户端渲染。
	assert.equal((await initialData('/sign.html')).pageStatus.status, 404);

	// 登录页是本站账号密码表单，不下发 Accounts 登录入口。
	const signForm = await (await request('/api/sign.php')).json();
	assert.equal(signForm.formPage.passportLogin, undefined);
	assert.deepEqual(signForm.formPage.fields.map((field) => field.name), ['user_name', 'password', 'remember']);

	// 误触发的 SDK 登录请求要给出明确提示，不能落到本地密码登录报"用户名或密码错误"。
	const sdkLogin = await request('/api/sign.php', { method: 'POST', body: { action: 'login' } });
	assert.equal(sdkLogin.status, 409);
	assert.match((await sdkLogin.json()).feedback.message, /未启用 Accounts 登录/);

	// 本站账号密码登录不受影响。
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'localadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'localadmin', password: 'test-password-123' } });
	assert.equal(login.status, 200);
	assert.ok(login.headers.get('set-cookie'));
	assert.deepEqual((await login.clone().json()).next, { action: 'navigate', path: '/', refreshAuth: true });

	// 身份中心站点和业务站点用同一套模块：后台同样有“Accounts 登录”设置页，可以在这里关掉这种登录方式。
	const cookie = login.headers.get('set-cookie').split(';')[0];
	assert.equal((await request('/api/panel/admin/global/site/hosts.php', { method: 'POST', headers: { cookie }, body: { hostname: 'accounts.test', site_key: 'passport' } })).status, 201);
	const siteDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	siteDatabase.prepare("INSERT INTO global_sites (key, name, base_site_key, dsn, database_binding, status, migration_status, is_default, is_system) VALUES ('business', 'Business', 'base', '', '', 'enabled', 'ready', 0, 0)").run();
	siteDatabase.close();
	assert.equal((await request('/api/panel/admin/global/site/hosts.php', { method: 'POST', headers: { cookie }, body: { hostname: 'business.test', site_key: 'business' } })).status, 201);
	const settingsPath = '/api/panel/admin/base/settings/accounts-oidc.php';
	const expectedSettingsFields = ['enabled', 'issuerSource', 'issuer', 'clientId', 'clientSecret'];
	const globalSettings = await (await request(settingsPath, { headers: { cookie } })).json();
	const siteHeaders = { cookie, 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData };
	const passportSettings = await (await app.request(`http://accounts.test${settingsPath}`, { headers: siteHeaders })).json();
	const businessSettings = await (await app.request(`http://business.test${settingsPath}`, { headers: siteHeaders })).json();
	assert.deepEqual(globalSettings.formPage.fields.map((field) => field.name), expectedSettingsFields);
	assert.deepEqual(passportSettings.formPage.fields.map((field) => field.name), expectedSettingsFields);
	assert.deepEqual(businessSettings.formPage.fields.map((field) => field.name), expectedSettingsFields);
	assert.deepEqual(passportSettings.formPage.actions.map((action) => action.key), ['test', 'restore-defaults']);
	const passportInitial = (await readPageContext(app, 'accounts.test', '/panel/admin/passport/dashboard.html', { headers: siteHeaders })).context;
	const navigationKeys = (items) => items.flatMap((item) => [String(item.key), ...navigationKeys(item.children ?? [])]);
	assert.ok(navigationKeys(passportInitial.siteNavigation).includes('/panel/admin/base/settings/accounts-oidc'));

	// 「保留本站登录」开关：接入 Accounts 之后两条登录路径并存。
	// 必须先开这个开关再启用 Accounts——启用那一刻本地会话立即失效，之后就进不来改它了。
	const sitePath = '/api/panel/admin/base/settings/site.php';
	const siteSettings = (await (await request(sitePath, { headers: { cookie } })).json()).currentValues;
	assert.equal(siteSettings.localLoginEnabled, false, '开关默认关闭');
	assert.equal((await request(sitePath, { method: 'PUT', headers: { cookie }, body: { ...siteSettings, localLoginEnabled: true, __changedFields: ['localLoginEnabled'] } })).status, 200);
	const oidcSettings = (await (await request(settingsPath, { headers: { cookie } })).json()).currentValues;
	assert.equal((await request(settingsPath, { method: 'PUT', headers: { cookie }, body: { ...oidcSettings, enabled: true, issuer: 'https://accounts.test', clientId: 'cid', clientSecret: 'sec', __changedFields: ['enabled', 'issuer', 'clientId', 'clientSecret'] } })).status, 200);
	const bothHome = await initialData('/');
	assert.deepEqual(
		bothHome.auth.actions.map((action) => action.action),
		['local-login', 'accounts-login'],
		'both 模式下两个登录入口都要出现',
	);
	assert.equal((await request('/api/sign.php', { method: 'POST', body: { user_name: 'localadmin', password: 'test-password-123' } })).status, 200, 'both 模式下本站密码登录仍然可用');
	// Accounts 那条路径的请求要放行给下游，不能被当成本地登录挡掉。
	assert.notEqual((await request('/api/sign.php', { method: 'POST', body: { action: 'login' } })).status, 409);

	console.log('accounts login disabled test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
