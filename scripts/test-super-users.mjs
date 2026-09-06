import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 超级用户与四眼原则。
 *
 * 在这之前审批不是关卡：进得来后台的三个角色都能批，提交人自己点一下批准就过了。
 * 现在只有 `.env` 里的超级用户能自己批自己，其余人只能批别人提的。
 */
const directory = await mkdtemp(join(tmpdir(), 'quick-react-super-users-'));
process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
process.env.SUPER_USER_IDS = '1';

try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?super-users=${Date.now()}`);
	await runMaintenanceAction('restore-admin', { user_name: 'superadmin', password: 'super-password-1' });
	// 每个人一台设备：审批记录里存的是 created_duid（设备用户），比对必须落到人——
	// 否则同一个人换台设备就成了「两个人」，四眼原则当场失效。这个用例用两台设备。
	const device = (index) => ({
		'content-type': 'application/json',
		'x-device-key': `0000000${index}-0000-4000-8000-00000000000${index}`,
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: `a${index}`, audio_cyrb53: `b${index}` }),
	});
	const signIn = async (userName, password, index) => (await app.request('http://localhost/api/sign.php', {
		method: 'POST', headers: device(index), body: JSON.stringify({ user_name: userName, password }),
	})).headers.get('set-cookie')?.split(';')[0];

	const superCookie = await signIn('superadmin', 'super-password-1', 1);
	const superHeaders = { ...device(1), cookie: superCookie, 'x-change-reason': encodeURIComponent('测试') };
	assert.ok(superCookie, '超级用户应能登录');

	// 第二个管理员：有审批权，但不在超级用户名单里。
	// 建号进审批队列（§13.6）：超级用户可以自己批自己，因此这里一步就能建完。
	assert.equal((await app.request('http://localhost/api/panel/admin/base/users.php', {
		method: 'POST', headers: superHeaders,
		body: JSON.stringify({ user_name: 'reviewer', password: 'super-password-2', roles: ['platform_admin'], status: 'enabled' }),
	})).status, 202);
	const queued = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: superHeaders })).json();
	assert.equal((await app.request('http://localhost/api/panel/admin/base/audit.php?action=approve', { method: 'POST', headers: superHeaders, body: JSON.stringify(queued.table.dataSource.map((row) => String(row.id))) })).status, 200);
	// 重名的建号要在**记录之前**挡掉：审批是先记录后应用，等 INSERT 撞索引才失败的话，
	// 队列里会留下一条指向从未写成的行的申请，批也批不动。
	const queuedNow = async () => (await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: superHeaders })).json()).table.dataSource.length;
	const queuedBefore = await queuedNow();
	const duplicate = await app.request('http://localhost/api/panel/admin/base/users.php', {
		method: 'POST', headers: superHeaders,
		body: JSON.stringify({ user_name: 'reviewer', password: 'super-password-3', roles: [], status: 'enabled' }),
	});
	assert.equal(duplicate.status, 409, '重名建号直接拒绝');
	assert.equal(await queuedNow(), queuedBefore, '被拒绝的建号不该进队列');
	const reviewerCookie = await signIn('reviewer', 'super-password-2', 2);
	const reviewerHeaders = { ...device(2), cookie: reviewerCookie, 'x-change-reason': encodeURIComponent('测试') };
	// 同一个人的第二台设备：duid 不同、人相同，仍然算「自己」。
	const reviewerSecondDevice = { ...device(3), cookie: await signIn('reviewer', 'super-password-2', 3), 'x-change-reason': encodeURIComponent('测试') };

	const settings = 'http://localhost/api/panel/admin/base/settings/site-frontend.php';
	const submit = (headers, footer) => app.request(settings, { method: 'PUT', headers, body: JSON.stringify({ footer, __changedFields: ['footer'] }) });
	const approve = async (headers) => {
		const pending = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers })).json();
		const ids = pending.table.dataSource.map((row) => String(row.id));
		const response = await app.request('http://localhost/api/panel/admin/base/audit.php?action=approve', { method: 'POST', headers, body: JSON.stringify(ids) });
		// 失败的响应把话放在 feedback.message 里（messagePayload 的形状）。
		const body = await response.json();
		return { status: response.status, message: body.message ?? body.feedback?.message ?? '' };
	};

	// 超级用户：自己提的自己就能批。单人运维的站点靠这条继续干活。
	assert.equal((await submit(superHeaders, '页脚甲')).status, 202);
	assert.equal((await approve(superHeaders)).status, 200, '超级用户可以自己批自己');

	// 普通管理员：自己提的批不动。
	assert.equal((await submit(reviewerHeaders, '页脚乙')).status, 202);
	const selfApproval = await approve(reviewerHeaders);
	assert.equal(selfApproval.status, 403, '普通管理员不能自己批自己');
	assert.match(selfApproval.message, /不能审批自己提交的申请/);
	// 换一台设备再试：duid 变了，人没变，照样挡住。
	assert.equal((await approve(reviewerSecondDevice)).status, 403, '换台设备不该绕过四眼原则');
	// 别人来批就通过。
	assert.equal((await approve(superHeaders)).status, 200, '别人提的可以批');

	// 反过来也成立：普通管理员批得动超级用户提的。
	assert.equal((await submit(superHeaders, '页脚丙')).status, 202);
	assert.equal((await approve(reviewerHeaders)).status, 200, '普通管理员可以批别人提的');

	// 撤销不受这道判定管：那是把自己提的东西收回去，不是替谁做决定。
	assert.equal((await submit(reviewerHeaders, '页脚丁')).status, 202);
	const withdraw = await app.request(`${settings}?action=withdraw-pending`, { method: 'POST', headers: reviewerHeaders, body: '{}' });
	assert.equal(withdraw.status, 200, '自己撤销自己的申请不受四眼原则限制');

	// 彻底删除只给超级用户：全站唯一不可逆、也不留痕的操作。
	const rows = 'http://localhost/api/panel/admin/base/data/rows.php?table=base_users&include=deleted';
	const purge = (headers) => app.request(`${rows}&action=purge`, { method: 'POST', headers, body: JSON.stringify(['999']) });
	assert.equal((await purge(reviewerHeaders)).status, 403, '普通管理员不能彻底删除');
	assert.notEqual((await purge(superHeaders)).status, 403, '超级用户过得了这道门（记录不存在是另一回事）');

	// 撤销与驳回互斥：自己提的只给撤销，别人提的才给驳回。提交人往往自己也有审批权，
	// 原先三个按钮一起摆出来，让人分不清该点哪个——而它们本来就作用在不同的申请上。
	const noticeActions = async (headers) => {
		const page = await (await app.request(settings, { headers })).json();
		return (page.formPage?.notice?.actions ?? []).map((action) => action.key);
	};
	assert.equal((await submit(reviewerHeaders, '页脚戊')).status, 202);
	assert.deepEqual(await noticeActions(reviewerHeaders), ['withdraw-pending'], '自己提的：只有撤销——普通管理员批不动也驳不回自己的');
	assert.deepEqual(await noticeActions(superHeaders), ['approve-pending', 'reject-pending'], '别人提的：批准与驳回，没有撤销');
	// 驳回只动别人提的那几条，因此不会撞上四眼原则整批失败。
	assert.equal((await app.request(`${settings}?action=reject-pending`, { method: 'POST', headers: superHeaders, body: '{}' })).status, 200);

	// 只有被否掉的新增能恢复。
	assert.equal((await submit(reviewerHeaders, '页脚己')).status, 202);
	const rejectedIds = await (async () => {
		const list = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: superHeaders })).json();
		const ids = list.table.dataSource.map((row) => String(row.id));
		assert.equal((await app.request('http://localhost/api/panel/admin/base/audit.php?action=reject', { method: 'POST', headers: superHeaders, body: JSON.stringify(ids) })).status, 200);
		return ids;
	})();
	const requeued = await app.request('http://localhost/api/panel/admin/base/audit.php?action=requeue', { method: 'POST', headers: superHeaders, body: JSON.stringify(rejectedIds) });
	assert.equal(requeued.status, 409, '被驳回的修改不给恢复——重新提交一次就是了');
	assert.match((await requeued.json()).feedback?.message ?? '', /只有被否掉的新增可以恢复/);

	console.log('super users test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
