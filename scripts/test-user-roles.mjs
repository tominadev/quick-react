import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-user-roles-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?user-roles=${Date.now()}`);
	const deviceKey = '00000000000040008000000000000001';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = async (path, options = {}) => {
		const requestUrl = new URL(path, 'http://test');
		if (!options.method && requestUrl.pathname.startsWith('/api/panel/') && !requestUrl.searchParams.has('include')) requestUrl.searchParams.set('include', 'schema,data');
		const headers = new Headers(options.headers);
		if (!headers.has('x-device-key')) headers.set('x-device-key', deviceKey);
		if (!headers.has('x-device-fingerprint')) headers.set('x-device-fingerprint', fingerprintData);
		if (options.cookie) headers.set('cookie', options.cookie);
		if (options.body !== undefined) headers.set('content-type', 'application/json');
		// 后台的写操作一律进审批队列（§11.3）——「立即生效」勾选框已废除。这些用例验的是
		// 业务行为本身，审批流程由 test:change-audit 单独覆盖，所以这里透明地把队列走完：
		// 收到 202 就把待审批的记录批掉，再把响应当成 200 交回去。
		const response = await app.request(`http://localhost${requestUrl.pathname}${requestUrl.search}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		if (response.status !== 202 || !options.cookie) return response;
		const auditHeaders = new Headers(headers);
		auditHeaders.set('content-type', 'application/json');
		const pending = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&status=pending', { headers: auditHeaders })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) {
			await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=approve', { method: 'POST', headers: auditHeaders, body: JSON.stringify(ids) });
		}
		return new Response(await response.text(), { status: 200, headers: response.headers });
	};

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'roleadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'roleadmin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie);
	const usersPath = '/api/panel/admin/base/users.php';

	// 角色列是多选下拉，选项来自代码里的角色对照表。
	const list = await (await request(usersPath, { cookie })).json();
	const rolesColumn = list.table.columns.find((column) => column.dataIndex === 'roles');
	assert.equal(rolesColumn.component, 'select');
	assert.equal(rolesColumn.multiple, true);
	assert.deepEqual(rolesColumn.options, [
		{ value: 'platform_admin', text: '平台管理员(platform_admin)' },
		{ value: 'platform_support', text: '平台客服(platform_support)' },
		{ value: 'tenant_admin', text: '租户管理员(tenant_admin)' },
		{ value: 'tenant_support', text: '租户客服(tenant_support)' },
		{ value: 'branch_admin', text: '分站管理员(branch_admin)' },
		{ value: 'branch_support', text: '分站客服(branch_support)' },
		{ value: 'agent', text: '代理(agent)' },
	]);

	// 历史 JSON 文本按数组返回，前端可以直接回填多选。
	const bootstrap = list.table.dataSource.find((row) => row.user_name === 'roleadmin');
	assert.deepEqual(bootstrap.roles, ['platform_admin']);

	// 新建用户接受数组角色。建号现在也进审批队列，外层包装会替它把队走完。
	assert.equal((await request(usersPath, { method: 'POST', cookie, body: { user_name: 'rolemember', password: 'test-password-123', roles: [], status: 'enabled' } })).status, 200);
	const created = (await (await request(usersPath, { cookie })).json()).table.dataSource.find((row) => row.user_name === 'rolemember');
	assert.deepEqual(created.roles, []);
	const detail = await (await request(`${usersPath}/${created.id}`, { cookie })).json();
	assert.deepEqual(detail.roles, []);

	// 隐式角色和未登记角色都不能被分配。
	for (const roles of [['user'], ['public'], ['owner']]) {
		const rejected = await request(usersPath, { method: 'POST', cookie, body: { user_name: `rolebad${roles[0].replace(/_/g, '')}`, password: 'test-password-123', roles } });
		assert.equal(rejected.status, 400);
		assert.match((await rejected.json()).feedback.message, /不支持的角色/);
	}

	// 编辑时同样校验，并且能把普通用户提升为管理员。
	const rejectedEdit = await request(`${usersPath}/${created.id}`, { method: 'PUT', cookie, body: { roles: ['owner'], __changedFields: ['roles'] } });
	assert.equal(rejectedEdit.status, 400);
	assert.equal((await request(`${usersPath}/${created.id}`, { method: 'PUT', cookie, body: { roles: ['tenant_admin'], __changedFields: ['roles'] } })).status, 200);
	const promoted = await (await request(`${usersPath}/${created.id}`, { cookie })).json();
	assert.deepEqual(promoted.roles, ['tenant_admin']);

	// 界面上的删除（单条与批量）一律发到集合地址、id 放在请求体里，不带路径参数。
	// 这一条曾经返回「API route did not return a response」。
	assert.equal((await request(usersPath, { method: 'DELETE', cookie, body: [created.id] })).status, 200);
	const remaining = await (await request(usersPath, { cookie })).json();
	assert.ok(!remaining.table.dataSource.some((row) => String(row.id) === String(created.id)), '批量删除应生效');
	assert.equal((await request(usersPath, { method: 'DELETE', cookie, body: [] })).status, 400, '没选记录要给出明确提示');

	// 注册开关：默认关闭，初始管理员那把一次性闩用掉之后就不再放行；开启后允许注册普通用户。
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'walkin', password: 'test-password-123' } })).status, 409, '默认不开放注册');
	const sitePath = '/api/panel/admin/base/settings/site-backend.php';
	const settings = (await (await request(sitePath, { cookie })).json()).currentValues;
	assert.equal(settings.registrationEnabled, false, '开关默认关闭');
	assert.equal((await request(sitePath, { method: 'PUT', cookie, body: { ...settings, registrationEnabled: true, __changedFields: ['registrationEnabled'] } })).status, 200);
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'walkin', password: 'test-password-123' } })).status, 201, '开启后允许注册');
	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'walkin', password: 'test-password-123' } })).status, 409, '用户名冲突要挡住');
	const walkIn = (await (await request(usersPath, { cookie })).json()).table.dataSource.find((row) => row.user_name === 'walkin');
	assert.deepEqual(walkIn.roles, [], '自助注册出来的是普通用户，不是管理员');
	// 页面入口与接口用同一个判定，不能出现「有入口点进去被拒绝」。
	assert.equal((await (await request('/api/sign.php?mode=sign-up')).json()).registrationAvailable, true);

	console.log('user roles test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
