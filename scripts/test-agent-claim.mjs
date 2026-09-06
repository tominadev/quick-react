import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 代理拉号。
 *
 * 代理是外部主体：它的接口走 self 作用域——照常留痕，但不进审批队列（没有谁是代理的
 * 审批人）。这个用例覆盖能拉的那一条路，以及全部拉不动的理由。
 */
const directory = await mkdtemp(join(tmpdir(), 'quick-react-agent-claim-'));
process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
process.env.SUPER_USER_IDS = '1';

try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?agent-claim=${Date.now()}`);
	await runMaintenanceAction('restore-admin', { user_name: 'superadmin', password: 'super-password-1' });
	const device = (index) => ({
		'content-type': 'application/json',
		'x-device-key': `0000000${index}-0000-4000-8000-00000000000${index}`,
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: `a${index}`, audio_cyrb53: `b${index}` }),
	});
	const signIn = async (userName, password, index) => (await app.request('http://localhost/api/sign.php', {
		method: 'POST', headers: device(index), body: JSON.stringify({ user_name: userName, password }),
	})).headers.get('set-cookie')?.split(';')[0];

	const superHeaders = { ...device(1), cookie: await signIn('superadmin', 'super-password-1', 1), 'x-change-reason': encodeURIComponent('测试') };
	// 建号进审批队列（§13.6）：超级用户可以自己批自己，因此建完立刻批一次就生效。
	const createUser = async (userName, roles) => {
		assert.equal((await app.request('http://localhost/api/panel/admin/base/users.php', {
			method: 'POST', headers: superHeaders,
			body: JSON.stringify({ user_name: userName, password: 'agent-password-1', roles, status: 'enabled' }),
		})).status, 202, `建号 ${userName} 应进审批队列`);
		const queued = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: superHeaders })).json();
		assert.equal((await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=approve', {
			method: 'POST', headers: superHeaders, body: JSON.stringify(queued.table.dataSource.map((row) => String(row.id))),
		})).status, 200, `批准 ${userName} 的建号申请`);
	};
	await createUser('agentone', ['agent']);
	await createUser('agenttwo', ['agent']);
	await createUser('plainuser', []);
	await createUser('otheruser', []);

	const agentHeaders = { ...device(2), cookie: await signIn('agentone', 'agent-password-1', 2), 'content-type': 'application/json' };
	const rivalHeaders = { ...device(3), cookie: await signIn('agenttwo', 'agent-password-1', 3), 'content-type': 'application/json' };
	const plainHeaders = { ...device(4), cookie: await signIn('plainuser', 'agent-password-1', 4), 'content-type': 'application/json' };

	const subordinates = 'http://localhost/api/panel/agent/subordinates.php';
	const claim = (headers, userName) => app.request(`${subordinates}?action=claim`, { method: 'POST', headers, body: JSON.stringify({ user_name: userName }) });
	const list = async (headers) => (await (await app.request(`${subordinates}?include=schema,data`, { headers })).json()).table;
	const refused = async (response) => { const body = await response.json(); return body.message ?? body.feedback?.message ?? ''; };

	// 只有代理进得来这道门。
	assert.equal((await app.request(subordinates, { headers: plainHeaders })).status, 403, '普通用户进不了代理中心');

	const before = await list(agentHeaders);
	assert.equal(before.dataSource.length, 0, '还没拉过人，下级列表是空的');
	assert.ok(before.option.actions.toolbar.some((action) => action.key === 'claim'), '工具栏上有「拉号」');

	// 能拉的那一条路。
	assert.equal((await claim(agentHeaders, 'plainuser')).status, 200, '无代理的用户可以拉');
	const after = await list(agentHeaders);
	assert.equal(after.dataSource.length, 1);
	assert.equal(after.dataSource[0].user_name, 'plainuser');
	// 拉过来只是挂了归属，不等于看得见对方的数据：另一个代理的下级仍然与自己无关。
	assert.equal((await list(rivalHeaders)).dataSource.length, 0, '别人的下级不出现在自己的列表里');

	// 拉不动的四种理由。
	assert.match(await refused(await claim(rivalHeaders, 'plainuser')), /已经有代理/, '已有代理的账号不能被抢走');
	assert.match(await refused(await claim(agentHeaders, 'agentone')), /不能把自己/, '不能拉自己');
	assert.match(await refused(await claim(agentHeaders, 'agenttwo')), /管理员或代理/, '带角色的账号不能作为下级');
	assert.match(await refused(await claim(agentHeaders, 'superadmin')), /管理员或代理/, '管理员不能被拉成下级');
	assert.match(await refused(await claim(agentHeaders, 'nosuchuser')), /没有用户/, '不存在的用户名');

	// 留痕：一条 self 作用域的 update，改的正是 agent_uid，且没有进过审批队列。
	const audit = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&table_name=base_users&scope=self', { headers: superHeaders })).json();
	const entry = audit.table.dataSource.find((row) => String(row.summary ?? '').includes('agent_uid'));
	assert.ok(entry, '拉号要留下一条记录');
	assert.equal(entry.action, 'update', '动作发原文,颜色和文案由列的 options 决定');
	assert.equal(entry.scope, 'self');
	assert.equal(entry.review_status, 'none', '代理的操作没有审批人，不进队列');
	assert.equal(entry.data_status, 'applied');
	assert.match(String(entry.summary), /agent_uid：未填写 → /, '记的是这一列从无到有');
	assert.equal(entry.request_path, '/api/panel/agent/subordinates', '记下这是从代理中心做的');

	console.log('agent claim test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
