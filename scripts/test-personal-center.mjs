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
	const deviceKey = '00000000000040008000000000000001';
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
		// 保留本站登录属于「前台后端设置」那一条。
		setup.prepare("UPDATE base_configs SET value = ? WHERE name = 'site_backend'")
			.run(JSON.stringify({ localLoginEnabled: true }));
		setup.close();
	}
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'meadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'meadmin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	// 撞名的对手：用户名唯一，且昵称不能占用别人的用户名（昵称没设时回落到用户名）。
	{
		const other = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		other.prepare('INSERT INTO base_users (key, name, roles, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)').run('otheruser', '[]', 'enabled', at, at);
		other.close();
	}

	/**
	 * 用户面与管理后台对称：顶层是 `/panel/user`，页面挂在它下面并带站点名
	 * （`/panel/user/base/me`）。`me` 直译成「我」；`user` 那一层叫「控制台」——并列的
	 * 「管理后台」「代理中心」都是场所名，菜单项回答的是「点进去是什么地方」。
	 *
	 * CDN 模式下导航不嵌在文档里，从上下文接口取。
	 */
	const navigation = (await readPageContext(app, 'localhost', '/', { cookie, headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } })).context.siteNavigation;
	const userPanel = navigation.find((item) => item.key === '/panel/user');
	assert.ok(userPanel, '用户面应该存在');
	assert.equal(userPanel.label, '控制台', '与并列的「管理后台」「代理中心」一样是场所名，不用身份名');
	// `['user']` 是「要登录」，不是特权：每个登录用户都带着这个角色。用户面到此为止，不再细分。
	assert.deepEqual(userPanel.roles, ['user'], '用户面要求登录');
	const me = (userPanel.children ?? []).find((item) => item.key === '/panel/user/base/me');
	assert.ok(me, '「我」应该在用户面下');
	assert.equal(me.label, '我');
	assert.deepEqual(me.children ?? [], [], '「我」不应该再有子页面');
	// 原来的子页面路径不再存在。CDN 模式下文档一律 200（可缓存的壳），404 由上下文的 pageStatus 下发。
	const removed = await readPageContext(app, 'localhost', '/panel/me/security.html', { cookie, headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
	assert.equal(removed.context.pageStatus.status, 404);

	// 未启用 Accounts 登录时只有身份信息，没有任何外站入口。
	const plain = await (await request('/api/panel/user/base/me.php', { cookie })).json();
	assert.equal(plain.user.user_name, 'meadmin');
	assert.equal(plain.accountsCenter, undefined);
	assert.equal(plain.accountsNotice, undefined);

	// 启用 Accounts 登录后给出说明和新页面入口，且入口指向账号中心。
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	database.prepare("INSERT INTO base_configs (created_at, updated_at, key, name, value) VALUES (?, ?, 'seed-oidc', 'accounts_oidc_client', ?)")
		.run(now, now, JSON.stringify({ enabled: true, issuer: 'https://accounts.test', clientId: 'acct', clientSecret: 'secret' }));
	database.close();
	const linked = await (await request('/api/panel/user/base/me.php', { cookie })).json();
	assert.match(linked.accountsNotice, /accounts\.test/);
	assert.match(linked.accountsNotice, /当前页面不会离开/);
	assert.deepEqual(linked.accountsCenter, { label: '在新页面打开账号中心', url: 'https://accounts.test/panel/accounts' });

	// 自助改资料：三组设置分成选项卡，各自提交——它们互不相干，各有各的失败方式，
	// 混在一起的话一处失败会让另外两处也白填。
	const mePath = '/api/panel/user/base/me.php';
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
	// 保存响应带回身份（页面上半截用）和一份**局部**上下文补丁（右上角用）。
	assert.equal(renamedBody.user.user_name, 'meadmin2');
	assert.equal(renamedBody.context.auth.currentUser.user_name, 'meadmin2');
	assert.equal(renamedBody.context.auth.currentUser.profile_nickname, 'meadmin2', '没设昵称时回落到新用户名');
	// 补丁只带变化的身份字段，不搬导航树、页面状态和可用动作。
	assert.deepEqual(Object.keys(renamedBody.context), ['auth']);
	assert.deepEqual(Object.keys(renamedBody.context.auth), ['currentUser']);
	assert.deepEqual(Object.keys(renamedBody.context.auth.currentUser).sort(), ['profile_nickname', 'user_name']);
	// 只回本段字段：整份回去的话，另外两段正在输入的内容会被一起重置。
	assert.deepEqual(Object.keys(renamedBody.currentValues), ['user_name']);
	assert.equal(renamedBody.formPage, undefined, '表单结构没变就不回 formPage');
	assert.equal((await meForm()).initialValues.user_name, 'meadmin2');
	assert.equal((await save({ _section: 'user_name', user_name: 'meadmin' })).status, 200, '改回来也是允许的（撞名检查要排除自己）');

	// —— 个人简介 ——
	const profileSave = (fields) => save({ _section: 'profile', profile_nickname: '', profile_qq: '', profile_wechat: '', profile_email: '', ...fields });
	/**
	 * **表单里编辑的是真值**：没设过昵称就是 `null`，控件显示成「未填写，点击填写」。
	 *
	 * 回落到用户名是**显示规则**，在看得到名字的地方做（右上角、列表），不在表单初值里
	 * ——在初值里回落的话，「不设昵称」就只能靠「把它改回用户名」这种没人猜得到的操作
	 * 来表达，而那一列明明是可空的。
	 */
	assert.equal(before.initialValues.profile_nickname, null, '没设过就是 null，不是回落后的用户名');
	assert.equal((await (await request(mePath, { cookie })).json()).user.profile_nickname, 'meadmin', '右上角显示的是昵称，没设过就回落到用户名');
	// 填成用户名仍然当作「没设昵称」：那是同一个显示效果，占着唯一索引没有意义。
	// 用户名只有 7 位、短于昵称下限 4 个半角也不该因此保存失败——比对必须发生在长度校验之前。
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
	/**
	 * **点 ✕ 清成「未填写」和删光字符留下空串是两件事,一路要传到库里。**
	 *
	 * 控件（NullableInput）分得开这两种,列上也声明了 `nullable: true`,可收参数那一行原先写的是
	 * `String(body[name] ?? '')`——null 在最靠近人的地方就被折成了空串,库里永远只存得下一种。
	 * `profileStatement` 里「联系方式不折」那段注释描述的行为因此根本走不到。
	 */
	const contactColumns = () => {
		const check = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
		const row = check.prepare("SELECT qq, wechat FROM base_user_profiles WHERE user_id = (SELECT id FROM base_users WHERE name = 'meadmin')").get();
		check.close();
		return row;
	};
	assert.equal((await save({ _section: 'profile', profile_qq: null })).status, 200, '清成未填写要能保存');
	assert.equal(contactColumns().qq, null, '点 ✕ 存 NULL');
	assert.equal(contactColumns().wechat, 'wxme', '只清一列，别的不受影响');
	assert.equal((await save({ _section: 'profile', profile_wechat: '' })).status, 200);
	assert.equal(contactColumns().wechat, '', '删光字符只是空串，不该被折成 NULL');
	assert.equal(contactColumns().qq, null, '前一列仍然是 NULL');

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
