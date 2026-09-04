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

	console.log('personal center test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
