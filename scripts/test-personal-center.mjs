import assert from 'node:assert/strict';
import { readPageContext } from './page-context.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// 个人中心只做只读展示：没有子页面，账号中心入口只能在新页面打开。
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-personal-center-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?personal-center=${Date.now()}`);
	const deviceKey = '00000000-0000-4000-8000-000000000001';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = async (path, options = {}) => {
		const headers = new Headers(options.headers);
		if (!headers.has('x-device-key')) headers.set('x-device-key', deviceKey);
		if (!headers.has('x-device-fingerprint')) headers.set('x-device-fingerprint', fingerprintData);
		if (options.cookie) headers.set('cookie', options.cookie);
		if (options.body !== undefined) headers.set('content-type', 'application/json');
		return app.request(`http://localhost${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
	};
	// 先开「保留本站登录」再启用 Accounts：否则启用那一刻本地会话立即失效，后面全 401。
	// 站点设置随请求配置一起缓存，直接写库绕不过缓存，因此必须在第一次请求之前写。
	{
		const setup = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		setup.prepare("INSERT INTO base_configs (created_at, updated_at, key, value) VALUES (?, ?, 'site-settings', ?)")
			.run(at, at, JSON.stringify({ localLoginEnabled: true }));
		setup.close();
	}
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { username: 'me_admin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { username: 'me_admin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];

	// 导航里个人中心只有一个页面，没有子菜单。
	// CDN 模式下导航不嵌在文档里，从上下文接口取。
	const navigation = (await readPageContext(app, 'localhost', '/', { cookie, headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).context.siteNavigation;
	const me = navigation.find((item) => item.key === '/panel/me');
	assert.ok(me, '个人中心应该存在');
	assert.deepEqual(me.children ?? [], [], '个人中心不应该再有子页面');
	assert.equal(me.dashboardPath, undefined);
	// 原来的子页面路径不再存在。CDN 模式下文档一律 200（可缓存的壳），404 由上下文的 pageStatus 下发。
	const removed = await readPageContext(app, 'localhost', '/panel/me/security.html', { cookie, headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(removed.context.pageStatus.status, 404);

	// 未启用 Accounts 登录时只有身份信息，没有任何外站入口。
	const plain = await (await request('/api/panel/me.php', { cookie })).json();
	assert.equal(plain.user.username, 'me_admin');
	assert.equal(plain.accountsCenter, undefined);
	assert.equal(plain.accountsNotice, undefined);

	// 启用 Accounts 登录后给出说明和新页面入口，且入口指向账号中心。
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	database.prepare("INSERT INTO base_configs (created_at, updated_at, key, value) VALUES (?, ?, 'accounts-oidc-client', ?)")
		.run(now, now, JSON.stringify({ enabled: true, issuer: 'https://accounts.test', clientId: 'acct', clientSecret: 'secret' }));
	database.close();
	const linked = await (await request('/api/panel/me.php', { cookie })).json();
	assert.match(linked.accountsNotice, /accounts\.test/);
	assert.match(linked.accountsNotice, /当前页面不会离开/);
	assert.deepEqual(linked.accountsCenter, { label: '在新页面打开账号中心', url: 'https://accounts.test/panel/accounts' });

	// 自助改资料：只能改自己这一行的用户名、昵称与密码。
	const mePath = '/api/panel/me.php';
	assert.deepEqual(
		(await (await request(mePath, { cookie })).json()).formPage.fields.map((field) => field.name),
		['username', 'nickname', 'currentPassword', 'newPassword'],
	);
	const save = (body) => request(mePath, { method: 'PUT', cookie, body });
	assert.equal((await save({ nickname: '小明', __changedFields: ['nickname'] })).status, 200, '昵称可以用中文');
	assert.equal((await save({ nickname: 'a\u0000b', __changedFields: ['nickname'] })).status, 400, '昵称不能带控制字符');
	// 昵称租户内唯一，但留空存 NULL，因此多个用户都不设昵称不会互相撞车。
	assert.equal((await save({ nickname: '', __changedFields: ['nickname'] })).status, 200, '留空表示不设置昵称');
	assert.equal((await save({ __changedFields: [] })).status, 400, '什么都没改要明确拒绝');
	// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
	assert.equal((await save({ newPassword: 'another-password-1', __changedFields: ['newPassword'] })).status, 403);
	assert.equal((await save({ currentPassword: 'test-password-123', newPassword: 'another-password-1', __changedFields: ['newPassword'] })).status, 200);
	assert.equal((await request('/api/sign.php', { method: 'POST', body: { username: 'me_admin', password: 'another-password-1' } })).status, 200, '新密码能登录');

	console.log('personal center test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
