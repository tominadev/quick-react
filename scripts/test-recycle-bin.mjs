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
		const pending = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: auditHeaders })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) {
			await app.request('http://localhost/api/panel/admin/base/audit.php?action=approve', { method: 'POST', headers: auditHeaders, body: JSON.stringify(ids) });
		}
		return new Response(await response.text(), { status: 200, headers: response.headers });
	};

	/**
	 * 把队列里剩下的都批掉。恢复现在也排队，用例要自己走完这一步。
	 *
	 * 走 request 而不是直接 app.request：设备标识那两个头由它统一带上，少带一个会被判成
	 * 换了设备，会话当场作废——下一个请求就是 401。
	 */
	const approvePending = async () => {
		const pending = await (await request('/api/panel/admin/base/audit.php?include=data&review_status=pending', { cookie })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (!ids.length) return;
		assert.equal((await request('/api/panel/admin/base/audit.php?action=approve', { method: 'POST', cookie, keepPending: true, body: ids })).status, 200);
	};

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'recycleadmin', password: 'test-password-123' } })).status, 201);
	const login = await request('/api/sign.php', { method: 'POST', body: { user_name: 'recycleadmin', password: 'test-password-123' } });
	const cookie = login.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie, '登录后应返回会话 Cookie');

	const rowsPath = '/api/panel/admin/base/data/rows.php?table=base_configs';
	assert.equal((await request('/api/panel/admin/recycle-bin.php', { cookie })).status, 404, '不应注册独立回收站接口');
	// 新建现在也进审批队列，外层包装会替它把队走完，因此这里是 200 而不是 201。
	assert.equal((await request(rowsPath, { method: 'POST', cookie, body: { name: 'recycle_fixture', value: 'test' } })).status, 200);
	const activeBefore = await (await request(rowsPath, { cookie })).json();
	const fixture = activeBefore.table.dataSource.find((row) => row.value === 'test');
	assert.ok(fixture, '测试记录应出现在普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	const activeAfter = await (await request(rowsPath, { cookie })).json();
	assert.equal(activeAfter.table.dataSource.some((row) => row.id === fixture.id), false, '软删除记录不应出现在普通列表');

	const recyclePath = `${rowsPath}&include=deleted,schema,data`;
	const deleted = await (await request(recyclePath, { cookie })).json();
	assert.ok(deleted.table.dataSource.some((row) => row.id === fixture.id), '软删除记录应出现在回收站');
	// 恢复**照常走审批**：它是把一条被批准删掉的记录重新对所有人可见，那是在推翻一个
	// 已经做过的决定。keepPending 让这里看见真实状态码，先确认它真的进了队列，
	// 再确认没批之前记录还留在回收站里。
	assert.equal((await request(`${recyclePath}&action=restore`, { method: 'POST', cookie, keepPending: true, body: [fixture.id] })).status, 202, '回收站的恢复要进审批队列');
	const stillDeleted = await (await request(rowsPath, { cookie })).json();
	assert.equal(stillDeleted.table.dataSource.some((row) => row.id === fixture.id), false, '没批准之前不该回到普通列表');
	// 待审批的恢复要能在**回收站里**看出来并就地处理。
	//
	// 审批表的查询原先跟着适配器的默认范围走，而回收站视图把它设成了 deleted——那说的是
	// 正在浏览的业务表。于是这些查询跑去「已删除的审批记录」里找，一条都找不到：行上不
	// 显示待审批（两个按钮被 visibleWhen 一起藏掉），点批准则报「审计记录不存在或无权访问」。
	const binView = await (await request(recyclePath, { cookie })).json();
	assert.equal(binView.table.dataSource.find((row) => row.id === fixture.id)?._pending, 'restore-mine', '回收站里也要标出待审批，并且说清等的是哪一种');
	const binActions = binView.table.option.actions.row.filter((action) => action.visibleWhen?.values?.includes('restore-mine')).map((action) => action.label);
	assert.deepEqual(binActions, ['撤销还原', '批准还原'], '回收站的行上要有说清动作的撤销与批准');
	assert.equal((await request(`${recyclePath}&action=approve-pending`, { method: 'POST', cookie, keepPending: true, body: [fixture.id] })).status, 200, '就地批准');
	const restored = await (await request(rowsPath, { cookie })).json();
	assert.ok(restored.table.dataSource.some((row) => row.id === fixture.id), '批准后记录应回到普通列表');

	assert.equal((await request(rowsPath, { method: 'DELETE', cookie, body: [fixture.id] })).status, 200);
	assert.equal((await request(`${recyclePath}&action=purge`, { method: 'POST', cookie, keepPending: true, body: [fixture.id] })).status, 200, '彻底删除也不排队');
	const purged = await (await request(recyclePath, { cookie })).json();
	assert.equal(purged.table.dataSource.some((row) => row.id === fixture.id), false, '彻底删除后回收站不应保留记录');
	// 审计表本身也受管：从「数据管理」改一条审计记录会照常留痕、照常走审批。
	// 递归由 runSystemSql 挡住（审计模块自己的写入不留痕），不靠把这张表排除在外。
	const auditBase = '/api/panel/admin/base/data/rows.php?table=base_approvals';
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
	assert.ok(afterTamper.table.dataSource.some((row) => row.table_name === 'base_approvals'), '改审计表也要留痕');

	// 审批页自己也是 TableCRUD 路由：它不给删除按钮（审批记录不该在这一页被删），但必须有
	// 回收站——「数据管理」能软删除任何表，包括这一张，删掉之后它就从审批页上消失，而审批页
	// 恰恰是唯一会去看它的地方。没有回收站的话，谁把审批记录删了既看不见也找不回。
	const approvals = '/api/panel/admin/base/audit.php';
	const approvalPage = await (await request(`${approvals}?include=schema,data&review_status=all`, { cookie })).json();
	const approvalToolbar = approvalPage.table.option.actions.toolbar.map((action) => action.key);
	assert.ok(approvalToolbar.includes('recycle-bin'), '审批页要有回收站入口');
	assert.equal(approvalToolbar.includes('delete'), false, '审批页不给删除按钮');
	const victim = approvalPage.table.dataSource[0].id;
	assert.equal((await request(`${auditBase}&include=schema,data`, { method: 'DELETE', cookie, body: [String(victim)] })).status, 200);
	const withoutVictim = await (await request(`${approvals}?include=data&review_status=all`, { cookie })).json();
	assert.equal(withoutVictim.table.dataSource.some((row) => String(row.id) === String(victim)), false, '软删除的审批记录不在正常列表');
	const approvalBin = await (await request(`${approvals}?include=schema,data,deleted&review_status=all`, { cookie })).json();
	assert.ok(approvalBin.table.dataSource.some((row) => String(row.id) === String(victim)), '软删除的审批记录要出现在审批页的回收站');
	assert.deepEqual(approvalBin.table.option.actions.toolbar.map((action) => action.key), ['restore', 'purge']);
	assert.equal((await request(`${approvals}/${victim}?include=deleted&action=restore`, { method: 'POST', cookie, keepPending: true, body: {} })).status, 202, '审批记录的恢复同样要进队列');
	await approvePending();
	const restoredApproval = await (await request(`${approvals}?include=data&review_status=all`, { cookie })).json();
	assert.ok(restoredApproval.table.dataSource.some((row) => String(row.id) === String(victim)), '恢复后要回到审批列表');

	console.log('recycle-bin test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
