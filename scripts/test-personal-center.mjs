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
	// 撞名的对手：用户名唯一，且昵称不能占用别人的用户名（昵称没设时回落到用户名）。
	{
		const other = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		other.prepare('INSERT INTO base_users (name, roles, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('otheruser', '[]', 'enabled', at, at);
		other.close();
	}

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

	// 自助改资料：三组设置分成选项卡，各自提交——它们互不相干，各有各的失败方式，
	// 混在一起的话一处失败会让另外两处也白填。
	const mePath = '/api/panel/me.php';
	const meForm = async () => (await (await request(mePath, { cookie })).json()).formPage;
	const before = await meForm();
	assert.equal(before.sectionLayout, 'tabs');
	assert.deepEqual(before.sections.map((section) => [section.key, section.title]), [['user_name', '用户名'], ['profile', '个人简介'], ['password', '修改密码']]);
	assert.deepEqual(before.sections.map((section) => section.fields.map((field) => field.name)),
		[['user_name'], ['profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email'], ['currentPassword', 'newPassword']]);
	const save = (body) => request(mePath, { method: 'PUT', cookie, body });

	// —— 用户名 ——
	assert.equal((await save({ _section: 'user_name', user_name: 'Me_Admin' })).status, 400, '不合规的用户名要拦下');
	assert.equal((await save({ _section: 'user_name', user_name: 'otheruser' })).status, 409, '撞上别的账号要明说');
	const renamed = await save({ _section: 'user_name', user_name: 'meadmin2' });
	assert.equal(renamed.status, 200);
	const renamedBody = await renamed.json();
	// 保存响应只带回身份本身，页面上半截和右上角都从它更新；整个认证上下文没必要搬。
	assert.equal(renamedBody.user.user_name, 'meadmin2');
	assert.equal(renamedBody.user.profile_nickname, 'meadmin2', '没设昵称时回落到新用户名');
	assert.equal(renamedBody.context, undefined, '改自己的资料不该把整个认证上下文搬过来');
	// 只回本段字段：整份回去的话，另外两段正在输入的内容会被一起重置。
	assert.deepEqual(Object.keys(renamedBody.currentValues), ['user_name']);
	assert.equal(renamedBody.formPage, undefined, '表单结构没变就不回 formPage');
	assert.equal((await meForm()).initialValues.user_name, 'meadmin2');
	assert.equal((await save({ _section: 'user_name', user_name: 'meadmin' })).status, 200, '改回来也是允许的（撞名检查要排除自己）');

	// —— 个人简介 ——
	const profileSave = (fields) => save({ _section: 'profile', profile_nickname: '', profile_qq: '', profile_wechat: '', profile_email: '', ...fields });
	// 昵称的默认值就是用户名（没设过时回落显示的那个），表单里不会是空白。
	assert.equal(before.initialValues.profile_nickname, 'meadmin');
	assert.equal((await (await request(mePath, { cookie })).json()).user.profile_nickname, 'meadmin', '右上角显示的是昵称，没设过就回落到用户名');
	// 原样提交回来当作「没设昵称」：不写资料行，继续回落。用户名只有 7 位、短于昵称下限
	// 4 个半角也不该因此保存失败——比对必须发生在长度校验之前。
	assert.equal((await profileSave({ profile_nickname: 'meadmin' })).status, 200);
	const untouched = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(untouched.prepare('SELECT nickname FROM base_user_profiles p JOIN base_users u ON u.id = p.user_id WHERE u.name = ?').get('meadmin')?.nickname ?? null, null, '原样保存不该写入昵称');
	untouched.close();
	assert.equal((await profileSave({ profile_nickname: '小明同学' })).status, 200, '昵称可以用中文');
	assert.equal((await profileSave({ profile_nickname: 'a\u0000bcd' })).status, 400, '昵称不能带控制字符');
	assert.equal((await profileSave({ profile_nickname: '小明' })).status, 200, '两个全角正好 4 个半角，是下限');
	assert.equal((await profileSave({ profile_nickname: '明' })).status, 400, '一个全角只有 2 个半角，太短');
	assert.equal((await profileSave({ profile_nickname: '一二三四五六七八九' })).status, 400, '九个全角 18 个半角，超了');
	assert.equal((await profileSave({ profile_nickname: 'otheruser' })).status, 400, '不能把别的账号的用户名占成自己的昵称');
	// 昵称留空存 NULL，因此多个用户都不设昵称不会互相撞车。
	assert.equal((await profileSave({ profile_nickname: '' })).status, 200, '留空表示不设置昵称');
	// 联系方式与昵称同在一张资料表，可以单独改；只清昵称不该把联系方式一起删掉。
	const contacts = await profileSave({ profile_qq: '10001', profile_wechat: 'wxme', profile_email: 'me@example.test' });
	assert.equal(contacts.status, 200);
	const contactsBody = await contacts.json();
	// 个人简介这一段只回 profile_ 开头的字段。
	assert.deepEqual(Object.keys(contactsBody.currentValues).sort(), ['profile_email', 'profile_nickname', 'profile_qq', 'profile_wechat']);
	const withContact = await meForm();
	assert.deepEqual(
		[withContact.initialValues.profile_qq, withContact.initialValues.profile_wechat, withContact.initialValues.profile_email],
		['10001', 'wxme', 'me@example.test'],
	);
	assert.equal((await save({ _section: 'profile' })).status, 400, '什么字段都没带要明确拒绝');
	assert.equal((await save({ _section: 'nope' })).status, 400, '没指明改哪一组也要拒绝');

	// —— 密码 ——
	// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
	assert.equal((await save({ _section: 'password', newPassword: 'another-password-1' })).status, 403);
	assert.equal((await save({ _section: 'password', currentPassword: 'test-password-123', newPassword: 'short' })).status, 400);
	const passwordSaved = await save({ _section: 'password', currentPassword: 'test-password-123', newPassword: 'another-password-1' });
	assert.equal(passwordSaved.status, 200);
	// 密码不回显；本来就有密码，那一段的结构也没变，因此不回 formPage。
	assert.deepEqual(await passwordSaved.json().then((body) => body.currentValues), { currentPassword: '', newPassword: '' });
	assert.equal((await request('/api/sign.php', { method: 'POST', body: { user_name: 'meadmin', password: 'another-password-1' } })).status, 200, '新密码能登录');

	console.log('personal center test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
