import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-user-roles-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?user-roles=${Date.now()}`);
	const deviceKey = '00000000-0000-4000-8000-000000000001';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = async (path, options = {}) => {
		const requestUrl = new URL(path, 'http://test');
		if (!options.method && requestUrl.pathname.startsWith('/api/panel/') && !requestUrl.searchParams.has('include')) requestUrl.searchParams.set('include', 'schema,data');
		const headers = new Headers(options.headers);
		if (!headers.has('x-device-key')) headers.set('x-device-key', deviceKey);
		if (!headers.has('x-device-fingerprint')) headers.set('x-device-fingerprint', fingerprintData);
		if (options.cookie) headers.set('cookie', options.cookie);
		if (options.body !== undefined) headers.set('content-type', 'application/json');
		// 后台的写操作默认走审批（§11.3）。这里模拟管理员勾了「立即生效」，
		// 用例验的是业务行为本身；审批流程由 test:change-audit 单独覆盖。
		if (!headers.has('x-change-immediate')) headers.set('x-change-immediate', '1');
		return app.request(`http://localhost${requestUrl.pathname}${requestUrl.search}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	};

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { username: 'role_admin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { username: 'role_admin', password: 'test-password-123' } });
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
	const bootstrap = list.table.dataSource.find((row) => row.username === 'role_admin');
	assert.deepEqual(bootstrap.roles, ['platform_admin']);

	// 新建用户接受数组角色。
	assert.equal((await request(usersPath, { method: 'POST', cookie, body: { username: 'role_member', password: 'test-password-123', roles: [], status: 'enabled' } })).status, 201);
	const created = (await (await request(usersPath, { cookie })).json()).table.dataSource.find((row) => row.username === 'role_member');
	assert.deepEqual(created.roles, []);
	const detail = await (await request(`${usersPath}/${created.id}`, { cookie })).json();
	assert.deepEqual(detail.roles, []);

	// 隐式角色和未登记角色都不能被分配。
	for (const roles of [['user'], ['public'], ['owner']]) {
		const rejected = await request(usersPath, { method: 'POST', cookie, body: { username: `role_bad_${roles[0]}`, password: 'test-password-123', roles } });
		assert.equal(rejected.status, 400);
		assert.match((await rejected.json()).feedback.message, /不支持的角色/);
	}

	// 编辑时同样校验，并且能把普通用户提升为管理员。
	const rejectedEdit = await request(`${usersPath}/${created.id}`, { method: 'PUT', cookie, body: { roles: ['owner'], __changedFields: ['roles'] } });
	assert.equal(rejectedEdit.status, 400);
	assert.equal((await request(`${usersPath}/${created.id}`, { method: 'PUT', cookie, body: { roles: ['tenant_admin'], __changedFields: ['roles'] } })).status, 200);
	const promoted = await (await request(`${usersPath}/${created.id}`, { cookie })).json();
	assert.deepEqual(promoted.roles, ['tenant_admin']);

	console.log('user roles test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
