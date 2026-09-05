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
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'meadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'meadmin', password: 'test-password-123' } });
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
	assert.equal(plain.user.user_name, 'meadmin');
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
		['user_name', 'profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email', 'currentPassword', 'newPassword'],
	);
	const save = (body) => request(mePath, { method: 'PUT', cookie, body });
	// 昵称的默认值就是用户名（没设过时回落显示的那个），表单里不会是空白。
	const beforeNickname = await (await request(mePath, { cookie })).json();
	assert.equal(beforeNickname.formPage.initialValues.profile_nickname, 'meadmin');
	assert.equal(beforeNickname.user.profile_nickname, 'meadmin', '右上角显示的是昵称，没设过就回落到用户名');
	// 原样提交回来当作「没设昵称」：不写资料行，继续回落。用户名只有 7 位、短于昵称下限
	// 4 个半角也不该因此保存失败——比对必须发生在长度校验之前。
	assert.equal((await save({ profile_nickname: 'meadmin', __changedFields: ['profile_nickname'] })).status, 200);
	const untouched = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(untouched.prepare('SELECT nickname FROM base_user_profiles p JOIN base_users u ON u.id = p.user_id WHERE u.name = ?').get('meadmin')?.nickname ?? null, null, '原样保存不该写入昵称');
	untouched.close();
	assert.equal((await save({ profile_nickname: '小明', __changedFields: ['profile_nickname'] })).status, 200, '昵称可以用中文');
	assert.equal((await save({ profile_nickname: 'a\u0000b', __changedFields: ['profile_nickname'] })).status, 400, '昵称不能带控制字符');
	// 昵称租户内唯一，但留空存 NULL，因此多个用户都不设昵称不会互相撞车。
	assert.equal((await save({ profile_nickname: '', __changedFields: ['profile_nickname'] })).status, 200, '留空表示不设置昵称');
	// 没设资料时昵称回落到用户名，因此不能把别的账号的用户名占成自己的昵称，
	// 否则两个账号会显示成同一个名字——这一条数据库约束管不了，只能查。
	assert.equal((await save({ profile_nickname: 'meadmin', __changedFields: ['profile_nickname'] })).status, 200, '自己的用户名可以');
	// 联系方式与昵称同在一张资料表，可以单独改；只清昵称不该把联系方式一起删掉。
	assert.equal((await save({ profile_qq: '10001', profile_wechat: 'wx_me', profile_email: 'me@example.test', __changedFields: ['profile_qq', 'profile_wechat', 'profile_email'] })).status, 200);
	const withContact = await (await request(mePath, { cookie })).json();
	assert.deepEqual(
		[withContact.formPage.initialValues.profile_qq, withContact.formPage.initialValues.profile_wechat, withContact.formPage.initialValues.profile_email],
		['10001', 'wx_me', 'me@example.test'],
	);
	assert.equal((await save({ profile_nickname: '', __changedFields: ['profile_nickname'] })).status, 200);
	assert.equal((await (await request(mePath, { cookie })).json()).formPage.initialValues.profile_qq, '10001', '清空昵称不该带走联系方式');
	assert.equal((await save({ __changedFields: [] })).status, 400, '什么都没改要明确拒绝');
	// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
	assert.equal((await save({ newPassword: 'another-password-1', __changedFields: ['newPassword'] })).status, 403);
	assert.equal((await save({ currentPassword: 'test-password-123', newPassword: 'another-password-1', __changedFields: ['newPassword'] })).status, 200);
	assert.equal((await request('/api/sign.php', { method: 'POST', body: { user_name: 'meadmin', password: 'another-password-1' } })).status, 200, '新密码能登录');

	console.log('personal center test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
