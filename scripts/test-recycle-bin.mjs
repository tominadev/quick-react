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
		const headers = new Headers(options.headers);
		headers.set('x-device-key', deviceKey);
		headers.set('x-device-fingerprint', fingerprintData);
		if (options.cookie) headers.set('cookie', options.cookie);
		if (options.body !== undefined) headers.set('content-type', 'application/json');
		return app.request(`http://localhost${path}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	};

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { username: 'recycle_admin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { username: 'recycle_admin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie, '登录后应返回会话 Cookie');

	const rowsPath = '/api/panel/admin/data/rows.php?table=base_configs';
	assert.equal((await request('/api/panel/admin/recycle-bin.php', { cookie })).status, 404, '不应注册独立回收站接口');
	assert.equal((await request(rowsPath, { method: 'POST', cookie, body: { key: 'recycle_fixture', value: 'test' } })).status, 201);
	const activeBefore = await (await request(rowsPath, { cookie })).json();
	const fixture = activeBefore.table.dataSource.find((row) => row.value === 'test');
	assert.ok(fixture, '测试记录应出现在普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	const activeAfter = await (await request(rowsPath, { cookie })).json();
	assert.equal(activeAfter.table.dataSource.some((row) => row.id === fixture.id), false, '软删除记录不应出现在普通列表');

	const recyclePath = `${rowsPath}&deleted=deleted`;
	const deleted = await (await request(recyclePath, { cookie })).json();
	assert.ok(deleted.table.dataSource.some((row) => row.id === fixture.id), '软删除记录应出现在回收站');
	assert.equal((await request(`${recyclePath}&action=restore`, { method: 'POST', cookie, body: [fixture.id] })).status, 200);
	const restored = await (await request(rowsPath, { cookie })).json();
	assert.ok(restored.table.dataSource.some((row) => row.id === fixture.id), '恢复后记录应回到普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	assert.equal((await request(`${recyclePath}&action=purge`, { method: 'POST', cookie, body: [fixture.id] })).status, 200);
	const purged = await (await request(recyclePath, { cookie })).json();
	assert.equal(purged.table.dataSource.some((row) => row.id === fixture.id), false, '彻底删除后回收站不应保留记录');
	console.log('recycle-bin test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
