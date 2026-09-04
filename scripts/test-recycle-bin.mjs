import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-recycle-bin-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?recycle-bin=${Date.now()}`);
	const deviceKey = '00000000-0000-4000-8000-000000000099';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = async (path, options = {}) => {
		const requestUrl = new URL(path, 'http://test');
		if (!options.method && requestUrl.pathname.startsWith('/api/panel/') && !requestUrl.searchParams.has('include')) requestUrl.searchParams.set('include', 'schema,data');
		const headers = new Headers(options.headers);
		headers.set('x-device-key', deviceKey);
		headers.set('x-device-fingerprint', fingerprintData);
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

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { username: 'recycle_admin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { username: 'recycle_admin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie, '登录后应返回会话 Cookie');

	const rowsPath = '/api/panel/admin/base/data/rows.php?table=base_configs';
	assert.equal((await request('/api/panel/admin/recycle-bin.php', { cookie })).status, 404, '不应注册独立回收站接口');
	assert.equal((await request(rowsPath, { method: 'POST', cookie, body: { key: 'recycle_fixture', value: 'test' } })).status, 201);
	const activeBefore = await (await request(rowsPath, { cookie })).json();
	const fixture = activeBefore.table.dataSource.find((row) => row.value === 'test');
	assert.ok(fixture, '测试记录应出现在普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	const activeAfter = await (await request(rowsPath, { cookie })).json();
	assert.equal(activeAfter.table.dataSource.some((row) => row.id === fixture.id), false, '软删除记录不应出现在普通列表');

	const recyclePath = `${rowsPath}&include=deleted,schema,data`;
	const deleted = await (await request(recyclePath, { cookie })).json();
	assert.ok(deleted.table.dataSource.some((row) => row.id === fixture.id), '软删除记录应出现在回收站');
	assert.equal((await request(`${recyclePath}&action=restore`, { method: 'POST', cookie, body: [fixture.id] })).status, 200);
	const restored = await (await request(rowsPath, { cookie })).json();
	assert.ok(restored.table.dataSource.some((row) => row.id === fixture.id), '恢复后记录应回到普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	assert.equal((await request(`${recyclePath}&action=purge`, { method: 'POST', cookie, body: [fixture.id] })).status, 200);
	const purged = await (await request(recyclePath, { cookie })).json();
	assert.equal(purged.table.dataSource.some((row) => row.id === fixture.id), false, '彻底删除后回收站不应保留记录');
	// 审计表只能由审计模块自己写：「数据管理」和回收站都是绕过业务语义的通用写入通道，
	// 放行等于让平台管理员随手改写自己的操作记录（§7.3）。
	const auditBase = '/api/panel/admin/base/data/rows.php?table=base_audit_entries';
	assert.equal((await request(`${auditBase.replace('?', '/1?')}`, { method: 'PUT', cookie, body: { reason: '篡改' } })).status, 403, '审计表不该允许编辑');
	assert.equal((await request(auditBase, { method: 'POST', cookie, body: { table_name: 'x', row_id: 1, action: 'update' } })).status, 403, '审计表不该允许新增');
	assert.equal((await request(auditBase, { method: 'DELETE', cookie, body: [1] })).status, 403, '审计表不该允许删除');
	assert.equal((await request(`${auditBase}&include=deleted,schema,data&action=purge`, { method: 'POST', cookie, body: [1] })).status, 403, '回收站也不该允许彻底删除审计记录');
	assert.equal((await request(`${auditBase}&include=schema,data`, { cookie })).status, 200, '只读仍然允许');

	console.log('recycle-bin test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
