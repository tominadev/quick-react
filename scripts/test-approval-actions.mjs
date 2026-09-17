import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * **空表的第一帧也必须带上审批按钮。**
 *
 * 表格结构（`option`）只在第一次响应里下发，之后前端只请求数据、结构用缓存的那一份
 * （见架构文档「表格配置随响应整体替换」）。所以结构里的东西**不能依赖当时有没有数据**
 * ——首帧那一刻不成立，就永远不成立。
 *
 * 这个测试的由来：撤销/批准/驳回三个按钮由公共层统一挂（api-response.mts 的
 * withPendingApproval），而它早先看到「一行都没有」就整个提前返回，按钮一个也挂不上。
 * 于是**凡是第一次打开时是空表的页面，审批按钮永远不出现**，手动刷新一次才有——推送密钥页
 * 每次都会踩到，因为它天生从空表开始。
 *
 * 因此这里故意用**一个全新的空库**跑：每张表都是零行，正是当年出问题的那个状态。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'approval-actions-'));
process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?approval=${Date.now()}`);
	await runMaintenanceAction('restore-admin', { user_name: 'approvaladmin', password: 'approval-password-1' });

	// 每个站点各绑一个域名：路由按域名解析站点，不绑就全落到默认站点上，那一半路由是 404。
	const hosts = { base: 'base.test', global: 'global.test', passport: 'passport.test', sms: 'sms.test', pve: 'pve.test', aliyun: 'aliyun.test' };
	const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	for (const [site, hostname] of Object.entries(hosts)) {
		seed.prepare('INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, \'enabled\', ?)').run(hostname, site, Date.now());
	}
	seed.close();

	const headers = { 'content-type': 'application/json', 'x-device-key': '00000000000040008000000000000001', 'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }) };
	const login = await app.request('http://global.test/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'approvaladmin', password: 'approval-password-1' }) });
	assert.equal(login.status, 200, '测试管理员要能登录');
	const authed = { ...headers, cookie: login.headers.get('set-cookie')?.split(';')[0] };

	const registry = await readFile(resolve(projectDirectory, 'server/.generated/worker-api-registry.mts'), 'utf8');
	const routes = [...registry.matchAll(/\{"site":"([^"]+)","path":"(\/api\/panel\/admin\/[^"]+)"\}/g)]
		.map((match) => ({ site: match[1], path: match[2] }))
		// 带参数的是单条记录的接口，不是列表。
		.filter((route) => !route.path.includes('/:'));
	assert.ok(routes.length >= 15, `后台表格路由太少，扫描逻辑可能失效：${routes.length}`);

/**
 * 首帧拿不到审批入口、但**不是缺陷**的页面，逐条写明理由。
 */
const exempt = new Map([
	['/api/panel/admin/base/data/rows', '数据管理：首帧还没选数据表，公共层解不出目标表因而跳过。它的「数据表」查询字段带 reloadSchema，选定之后前端会重新取结构，那一帧才是这页真正的首帧'],
	['/api/panel/admin/base/data/columns', '数据管理的字段页：改的是表结构本身，不是某张表里的行，没有可审批的行记录'],
	['/api/panel/admin/global/cloud/object-storage/objects', '对象列表来自云厂商接口，不是数据库表，没有行可以进审批队列'],
]);

	const problems = [];
	let checked = 0;
	for (const route of routes) {
		const host = hosts[route.site];
		if (!host) continue;
		const response = await app.request(`http://${host}${route.path}.php?include=schema,data`, { headers: authed });
		if (response.status !== 200) continue;
		const body = await response.json().catch(() => ({}));
		const option = body.table?.option;
		// 不是表格页（Dashboard、目录节点）就跳过；没有行动作的表格也跳过——那种页面
		// 本来就不提供行上的操作，挂审批按钮没有意义。
		if (!option || !Array.isArray(option.actions?.row) || !option.actions.row.length) continue;
		checked += 1;
		const keys = option.actions.row.map((action) => action.key);
		if (exempt.has(route.path)) continue;
		if (!keys.includes('withdraw-pending')) {
			problems.push(`${route.path}（站点 ${route.site}）首帧的行动作里没有审批入口：${keys.join(', ')}`);
		}
	}

	assert.ok(checked >= 10, `实际检查到的表格页太少，扫描逻辑可能失效：${checked}`);
	assert.deepEqual(problems, [], `以下页面在空表时拿不到审批按钮，而结构只有第一帧那一次机会：\n  ${problems.join('\n  ')}`);
	console.log(`approval actions test passed（${checked} 个后台表格页，空库首帧都带审批入口）`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
