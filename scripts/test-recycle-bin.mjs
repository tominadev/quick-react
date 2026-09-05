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
		// 后台的写操作一律进审批队列（§11.3）——「立即生效」勾选框已废除。这些用例验的是
		// 业务行为本身，审批流程由 test:change-audit 单独覆盖，所以这里透明地把队列走完：
		// 收到 202 就把待审批的记录批掉，再把响应当成 200 交回去。
		const response = await app.request(`http://localhost${requestUrl.pathname}${requestUrl.search}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		// keepPending 的用例要亲自看见排队这件事，别替它把队走完。
		if (response.status !== 202 || !options.cookie || options.keepPending) return response;
		const auditHeaders = new Headers(headers);
		auditHeaders.set('content-type', 'application/json');
		const pending = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&status=pending', { headers: auditHeaders })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) {
			await app.request('http://localhost/api/panel/admin/base/audit.php?action=approve', { method: 'POST', headers: auditHeaders, body: JSON.stringify(ids) });
		}
		return new Response(await response.text(), { status: 200, headers: response.headers });
	};

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'recycleadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'recycleadmin', password: 'test-password-123' } });
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
	// 审计表本身也受管：从「数据管理」改一条审计记录会照常留痕、照常走审批。
	// 递归由 runSystemSql 挡住（审计模块自己的写入不留痕），不靠把这张表排除在外。
	const auditBase = '/api/panel/admin/base/data/rows.php?table=base_audit_entries';
	const auditList = await (await request(`${auditBase}&include=schema,data`, { cookie })).json();
	assert.ok(auditList.table.dataSource.length, '前面的操作应该已经留下审计记录');
	const entryId = auditList.table.dataSource[0].id;
	// 改审计记录同样要排队——审计表自己不例外。
	const pendingTamper = await request(auditBase.replace('?', `/${entryId}?`), { method: 'PUT', cookie, keepPending: true, body: { reason: '试图改写' } });
	assert.equal(pendingTamper.status, 202, '改审计记录同样要走审批');
	const stillPending = await (await request(`${auditBase}&include=schema,data`, { cookie })).json();
	assert.notEqual(stillPending.table.dataSource.find((row) => String(row.id) === String(entryId)).reason, '试图改写', '没批准之前不该生效');
	// 批准之后写进去，但这次改动本身留下一条新记录——想抹干净就得无限抹下去，
	// 篡改因此总是可见的。
	assert.equal((await request(auditBase.replace('?', `/${entryId}?`), { method: 'PUT', cookie, body: { reason: '改写了' } })).status, 200);
	const afterTamper = await (await request(`${auditBase}&include=schema,data`, { cookie })).json();
	assert.equal(afterTamper.table.dataSource.find((row) => String(row.id) === String(entryId)).reason, '改写了');
	assert.ok(afterTamper.table.dataSource.some((row) => row.table_name === 'base_audit_entries'), '改审计表也要留痕');

	console.log('recycle-bin test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
