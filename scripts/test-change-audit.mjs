import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const projectDirectory = resolve(import.meta.dirname, '..');

/**
 * 状态筛选走真实 HTTP，而不是只对源码做正则匹配。
 *
 * 地址栏 `?q.status=all` 会被前端去掉 `q.` 前缀发成 `status=all`，因此这里请求的
 * 参数名就是 `status`。参数缺失要回落到默认值「待审批」——否则下拉框显示待审批、
 * 列表却是全部。
 */
const auditRouteFilter = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'quick-react-audit-route-'));
	const previousFile = process.env.DEFAULT_DATABASE_FILE;
	process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
	process.env.SKIP_SERVER_LISTEN = '1';
	try {
		const { app, runMaintenanceAction } = await import(`../dist/server.mjs?audit-route=${Date.now()}`);
		await runMaintenanceAction('restore-admin', { user_name: 'auditadmin', password: 'audit-password-1' });
		const { DatabaseSync } = await import('node:sqlite');
		const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		for (const [id, status] of [['1', 'pending'], ['2', 'applied'], ['3', 'rejected'], ['4', 'pending']]) {
			seed.prepare('INSERT INTO base_audit_entries (created_at,updated_at,operation_id,reason,table_name,row_id,action,changes,status) VALUES (?,?,?,?,?,?,?,?,?)')
				.run(at, at, id, `理由${id}`, 'base_users', id, 'update', '{}', status);
		}
		seed.close();
		const headers = {
			'content-type': 'application/json',
			'x-device-key': '00000000-0000-4000-8000-000000000001',
			'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
		};
		const login = await app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'auditadmin', password: 'audit-password-1' }) });
		const cookie = login.headers.get('set-cookie')?.split(';')[0];
		const statuses = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			return (await response.json()).table.dataSource.map((row) => row.status).sort();
		};
		assert.deepEqual(await statuses(''), ['pending', 'pending'], '参数缺失回落到默认的待审批');
		assert.deepEqual(await statuses('&status=pending'), ['pending', 'pending']);
		assert.deepEqual(await statuses('&status=applied'), ['applied']);
		// 这就是 /panel/admin/base/audit.html?q.status=all 实际发出的请求。
		assert.deepEqual(await statuses('&status=all'), ['applied', 'pending', 'pending', 'rejected'], 'status=all 要返回全部');

		// 总数要跟着筛选条件走，而且不能拿列表长度充数——列表有 200 条上限，
		// 库里更多时那样会谎报「共 200 条」。
		const totals = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			const body = await response.json();
			return { total: body.table.totalRecords, rows: body.table.dataSource.length };
		};
		assert.deepEqual(await totals('&status=all'), { total: 4, rows: 4 });
		assert.deepEqual(await totals('&status=applied'), { total: 1, rows: 1 }, '总数要跟着筛选走');
		assert.deepEqual(await totals(''), { total: 2, rows: 2 });
		const overflow = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const now = Date.now();
		for (let index = 0; index < 250; index += 1) {
			overflow.prepare('INSERT INTO base_audit_entries (created_at,updated_at,operation_id,reason,table_name,row_id,action,changes,status) VALUES (?,?,?,?,?,?,?,?,?)')
				.run(now, now, `bulk${index}`, '批量', 'base_users', String(index), 'update', '{}', 'pending');
		}
		overflow.close();
		const capped = await totals('&status=pending');
		assert.equal(capped.rows, 200, '列表仍按上限返回');
		assert.equal(capped.total, 252, '总数是真实条数，不是取回的条数');
	} finally {
		if (previousFile === undefined) delete process.env.DEFAULT_DATABASE_FILE;
		else process.env.DEFAULT_DATABASE_FILE = previousFile;
		await rm(directory, { recursive: true, force: true });
	}
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-change-audit-'));
try {
	const result = await build({
		stdin: {
			contents: "export * from './server/database/sql.mts'; export * from './server/database/sqlite.mts'; export * from './server/database/index.mts'; export * from './server/modules/base/operation.mts'; export * from './server/modules/base/audit.mts';",
			resolveDir: projectDirectory, sourcefile: 'audit-test-entry.mts',
		},
		bundle: true, format: 'esm', platform: 'node', write: false,
	});
	const moduleFile = join(temporaryDirectory, 'audit.mjs');
	await writeFile(moduleFile, result.outputFiles[0].contents);
	const { allSql, createSqliteAdapter, firstSql, parseAuditChanges, publicAuditChanges, purgeAuditRetention, purgeExpiredAuditEntries, transitionAuditEntries, runOperationSql, runSql, sql, withDatabaseActors } = await import(pathToFileURL(moduleFile));

	const database = createSqliteAdapter(join(temporaryDirectory, 'audit.sqlite'));
	const migrations = resolve(projectDirectory, 'migrations/base');
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
		await database.exec(await readFile(resolve(migrations, file), 'utf8'));
	}

	// 统计准备的语句，用来验证不该留痕的写入不产生额外读取。
	let prepared = [];
	const counting = { ...database, prepare: (query) => { prepared.push(query); return database.prepare(query); } };
	const reset = () => { prepared = []; };
	// 后台请求拿到的适配器：绑定了主体，并且标记为人工操作。
	const acting = withDatabaseActors(counting, { subjectRoles: ['platform_admin'], humanOperation: true });
	// runOperation 只用请求上下文取「操作原因」，测试给一个最小桩。
	// 原因走 X-Change-Reason 请求头，客户端 encodeURIComponent 后再发。
	// 默认「立即生效」，绝大多数用例验的是留痕本身；审批那几条单独构造未勾选的上下文。
	const context = (reason, immediate = true) => ({
		req: {
			path: '/api/panel/admin/base/users',
			header: (name) => name === 'x-change-reason' ? (reason === undefined ? undefined : encodeURIComponent(reason)) : name === 'x-change-immediate' && immediate ? '1' : undefined,
		},
		get: (key) => key === 'effectiveRoles' ? ['platform_admin'] : undefined,
		set: () => {},
	});
	const op = (statement, options) => runOperationSql(context(), acting, statement, options);

	const entries = async () => (await allSql(acting, sql({ database: acting }).select({ table: 'base_audit_entries', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }))).map((entry) => ({ ...entry, id: String(entry.id) }));
	const changesOf = (entry) => JSON.parse(entry.changes);
	const latestEntry = async () => (await entries()).at(-1);

	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'alice', roles: '[]', status: 'enabled' }));
	const alice = await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: 'alice' }] }));

	// 新增不产生审计条目（§3.0）：insert 不带元信息，因此 runSql 也不会拦它。
	assert.equal((await entries()).length, 0, '新增不应产生审计条目');

	// ---- 看门人：人工请求里的受管写入必须走操作层 ----
	await assert.rejects(
		() => runSql(acting, sql({ database: acting }).update('base_users', { name: 'x' }, { id: alice.id })),
		/必须走 runOperation/,
		'漏包 runOperation 必须立刻报错，而不是静默少一条证据',
	);
	assert.equal((await entries()).length, 0);
	// 非人工请求（登录、回调、迁移、清理）照旧直写，不受约束也不留痕。
	const machine = withDatabaseActors(counting, { subjectRoles: ['platform_admin'] });
	await runSql(machine, sql({ database: machine }).update('base_users', { name: 'by-machine' }, { id: alice.id }));
	assert.equal((await entries()).length, 0, '非人工请求的写入不留痕');
	await runSql(machine, sql({ database: machine }).update('base_users', { name: 'alice' }, { id: alice.id }));

	// ---- 记录内容 ----
	reset();
	await op(sql({ database: acting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }), { reason: '客户改名申请 #1024' });
	let all = await entries();
	assert.equal(all.length, 1);
	assert.equal(all[0].table_name, 'base_users');
	assert.equal(String(all[0].row_id), String(alice.id));
	assert.equal(all[0].action, 'update');
	assert.equal(all[0].status, 'applied');
	assert.equal(all[0].reason, '客户改名申请 #1024', '操作原因要记下来——审计记了改了什么，这一列记为什么');
	assert.ok(all[0].operation_id, '每条记录都属于某一次操作');
	assert.deepEqual(changesOf(all[0]), { name: { before: 'alice', after: 'alice-2' } }, '未变化的 status 不应出现在 changes 里');
	assert.ok(prepared.some((query) => query.startsWith('SELECT')), '业务变更要读一次原行');

	// 原因随表单一起提交时从请求体里取，业务路由因此不用改签名。
	await runOperationSql(context('表单里填的原因：中文也要能过'), acting, sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await latestEntry()).reason, '表单里填的原因：中文也要能过', '请求头里的原因要能正确解码');
	await op(sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: alice.id }));

	// 提交未改动的字段不产生噪音，全部未变化时不产生记录。
	const beforeNoop = (await entries()).length;
	await op(sql({ database: acting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }));
	assert.equal((await entries()).length, beforeNoop, '逐列一致时不应产生记录');

	// 数组值要按驱动的绑定规则归一：写入的是数组，读回来的是 JSON 文本。
	// 不归一的话同样的值再存一次会被判成「变了」，撤回时的值校验也永远匹配不上。
	const beforeArray = (await entries()).length;
	await op(sql({ database: acting }).update('base_users', { roles: ['tenant_admin'] }, { id: alice.id }));
	const arrayEntry = await latestEntry();
	assert.equal((await entries()).length, beforeArray + 1);
	// 两边都是数组：SQLite 没有 JSON 类型是存储细节，不该漏进审计记录。
	assert.deepEqual(changesOf(arrayEntry).roles, { before: [], after: ['tenant_admin'] }, '数组列两边都记成数组');
	await op(sql({ database: acting }).update('base_users', { roles: ['tenant_admin'] }, { id: alice.id }));
	assert.equal((await entries()).length, beforeArray + 1, '同样的数组再存一次不该产生记录');
	// 同一列不能因为写入形态不同而记成两种样子：路由层传数组、「数据管理」的表单传
	// JSON 字符串，两条路径都要还原成数组。
	await op(sql({ database: acting }).update('base_users', { roles: '["branch_admin"]' }, { id: alice.id }));
	assert.deepEqual(changesOf(await latestEntry()).roles, { before: ['tenant_admin'], after: ['branch_admin'] }, '写入 JSON 字符串时同样记成数组');
	assert.equal((await transitionAuditEntries(acting, [(await latestEntry()).id], 'reverted'))[0].ok, true, '写入字符串的那条也要能撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles, '["tenant_admin"]');
	assert.equal((await transitionAuditEntries(acting, [arrayEntry.id], 'reverted'))[0].ok, true, '数组列必须能撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles, '[]');

	// ---- 一次操作可以包含多条写入，它们共享同一个 operation_id 与同一条原因 ----
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'bob', roles: '[]', status: 'disabled' }));
	const bob = await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: 'bob' }] }));
	const beforeMulti = (await entries()).length;
	const { runOperation } = await import(pathToFileURL(moduleFile));
	await runOperation(context(), acting, [
		sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }),
		sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: bob.id }),
	], { reason: '批量调整状态' });
	const multi = (await entries()).slice(beforeMulti);
	assert.equal(multi.length, 2, '一次操作写两行就记两条');
	assert.equal(multi[0].operation_id, multi[1].operation_id, '同一次操作共享 operation_id');
	assert.ok(multi.every((entry) => entry.reason === '批量调整状态'));
	await op(sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: alice.id }));

	// ---- 请求内的机器写入：显式声明，不留痕 ----
	const { runSystemSql } = await import(pathToFileURL(moduleFile));
	const beforeSystem = (await entries()).length;
	await runSystemSql(acting, sql({ database: acting }).update('base_users', { name: 'incidental' }, { id: bob.id }));
	assert.equal((await entries()).length, beforeSystem, 'runSystemSql 是显式声明「这不是人做的修改」');

	// ---- 软删除与恢复 ----
	await op(sql({ database: acting }).softDelete('base_users', { id: alice.id }));
	await op(sql({ database: acting }).restore('base_users', { id: alice.id }));
	all = await entries();
	assert.equal(all.at(-2).action, 'soft_delete');
	assert.equal(Number(changesOf(all.at(-2)).deleted_at.before), 0);
	assert.ok(Number(changesOf(all.at(-2)).deleted_at.after) > 0);
	assert.equal(all.at(-1).action, 'restore');
	assert.equal(Number(changesOf(all.at(-1)).deleted_at.after), 0);

	// 物理删除不产生记录。
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'temp', roles: '[]', status: 'enabled' }));
	const beforePurgeRow = (await entries()).length;
	await runSql(acting, sql({ database: acting }).delete('base_users', { name: 'temp' }));
	assert.equal((await entries()).length, beforePurgeRow, '物理删除不应产生记录');

	// ---- 操作者与归属：created_duid 是真实操作者，owner_uid 是作用账号（§4.1）----
	const delegated = sql({ database: acting, actorUid: '77', ownerUid: '42', ownerTid: '3', ownerBid: '5' });
	await runOperationSql(context(), acting, delegated.update('base_users', { name: 'alice-3' }, { id: alice.id }));
	const delegatedEntry = await latestEntry();
	assert.equal(String(delegatedEntry.created_duid), '77', 'created_duid 应是客服的 device-user');
	assert.equal(String(delegatedEntry.owner_uid), '42', 'owner_uid 应是被代查的账号');
	assert.equal(String(delegatedEntry.owner_tid), '3');
	assert.equal(String(delegatedEntry.owner_bid), '5');

	// ---- 审计写入失败时，业务写入一并失败（§6.2）----
	// 只让写入失败：读要照常，操作层现在会先查一次这个人有没有挂着的待审批记录。
	const failWrite = async () => { throw new Error('audit write failed'); };
	const failing = withDatabaseActors({
		...database,
		prepare: (query) => query.startsWith('INSERT INTO "base_audit_entries"') || query.startsWith('UPDATE "base_audit_entries"')
			? { bind: () => ({ run: failWrite, first: failWrite, all: failWrite }) }
			: database.prepare(query),
	}, { subjectRoles: ['platform_admin'], humanOperation: true });
	await assert.rejects(
		() => runOperationSql(context(), failing, sql({ database: failing }).update('base_users', { name: 'alice-4' }, { id: alice.id })),
		/audit write failed/,
		'审计写不进去时整个操作必须失败',
	);
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: alice.id }] }))).name, 'alice-3', '审计失败后业务数据不应被改动');

	// ---- 撤回（§7）----
	const nameOf = async (id) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: id }], deleted: 'all' }))).name;
	const statusOf = async (entryId) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_audit_entries', columns: { status: 'status' }, where: [{ column: 'id', value: entryId }] }))).status;
	const revert = (ids, reason = '') => transitionAuditEntries(acting, ids, 'reverted', reason);
	const restore = (ids, reason = '') => transitionAuditEntries(acting, ids, 'applied', reason);
	const entryById = async (id) => (await entries()).find((entry) => entry.id === id);

	// 撤回不新开记录，而是把这一条翻到另一面。
	await op(sql({ database: acting }).update('base_users', { name: 'dave' }, { id: alice.id }));
	const daveEntry = await latestEntry();
	const beforeRevert = (await entries()).length;
	// 「恢复」按钮点在一条已生效的记录上（列表过期）：拒绝，而不是翻成相反方向。
	assert.deepEqual(await restore([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前状态是「已生效」，不能执行这个操作' }]);
	assert.equal(await nameOf(alice.id), 'dave', '被拒绝时数据不变');
	assert.deepEqual(await revert([daveEntry.id], '撤回理由：改错了'), [{ id: daveEntry.id, ok: true, message: '已撤回' }]);
	assert.equal(await nameOf(alice.id), 'alice-3', '撤回后字段应恢复原值');
	assert.equal(await statusOf(daveEntry.id), 'reverted');
	assert.equal((await entries()).length, beforeRevert, '撤回不产生新的审计记录');
	// 翻转的操作者、时间与理由另存三列：原记录的 created_* 属于原操作者，不能复用。
	const flipped = await entryById(daveEntry.id);
	assert.equal(flipped.revert_reason, '撤回理由：改错了');
	assert.ok(Number(flipped.reverted_at) > 0, '要记下什么时候撤的');
	assert.equal(flipped.reason, daveEntry.reason, '原操作的理由不应被覆盖');

	// 撤回错了就再翻回来，不会堆出一串互相指向的记录。
	assert.deepEqual(await revert([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前状态是「已撤回」，不能执行这个操作' }]);
	assert.deepEqual(await restore([daveEntry.id], '恢复：撤错了'), [{ id: daveEntry.id, ok: true, message: '已恢复' }]);
	assert.equal(await nameOf(alice.id), 'dave', '恢复后应回到变更后的值');
	assert.equal(await statusOf(daveEntry.id), 'applied');
	assert.equal((await entries()).length, beforeRevert, '恢复同样不产生新记录');
	// 撤回与恢复各写自己那一组：恢复不能把「谁撤的」覆盖掉。
	const afterRestore = await entryById(daveEntry.id);
	assert.equal(afterRestore.restore_reason, '恢复：撤错了');
	assert.ok(Number(afterRestore.restored_at) > 0, '要记下什么时候恢复的');
	assert.equal(afterRestore.revert_reason, '撤回理由：改错了', '恢复不能覆盖撤回理由');
	assert.ok(Number(afterRestore.reverted_at) > 0, '撤回时间要保留');
	// 再撤回一次，把数据放回后面用例期望的位置。
	assert.equal((await revert([daveEntry.id]))[0].ok, true);
	assert.equal(await nameOf(alice.id), 'alice-3');

	// 要还原的列在变更之后又被改过时，撤回被拒绝且数据不变。
	await op(sql({ database: acting }).update('base_users', { name: 'erin' }, { id: alice.id }));
	const erinEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'frank' }, { id: alice.id }));
	const rejected = await revert([erinEntry.id]);
	assert.equal(rejected[0].ok, false);
	assert.match(rejected[0].message, /已被后续修改覆盖/);
	assert.equal(await nameOf(alice.id), 'frank', '撤回被拒绝时数据不变');
	assert.equal(await statusOf(erinEntry.id), 'applied', '被拒绝的记录不应标记为已撤回');

	// 同一行上与本次变更无关的列被改过，不影响撤回。
	await op(sql({ database: acting }).update('base_users', { name: 'grace' }, { id: alice.id }));
	const graceEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await revert([graceEntry.id]))[0].ok, true, '无关列被改动不应挡住撤回');
	assert.equal(await nameOf(alice.id), 'frank');

	// 同一列的两次连续变更：倒序撤回全部成功，数据回到最初值。
	await op(sql({ database: acting }).update('base_users', { name: 'step-b' }, { id: alice.id }));
	const stepB = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'step-c' }, { id: alice.id }));
	const stepC = await latestEntry();
	const chained = await revert([stepB.id, stepC.id]);
	assert.deepEqual(chained.map((r) => r.ok), [true, true], '链式变更倒序撤回应全部成功');
	assert.equal(chained[0].id, stepC.id, '执行顺序必须是从新到旧，不沿用传入顺序');
	assert.equal(await nameOf(alice.id), 'frank', '连续撤回后应回到最初值');
	// 恢复方向相反：从旧到新才走得通。
	const restored = await restore([stepC.id, stepB.id]);
	assert.deepEqual(restored.map((r) => r.ok), [true, true], '链式恢复应全部成功');
	assert.equal(restored[0].id, stepB.id, '恢复必须从旧到新');
	assert.equal(await nameOf(alice.id), 'step-c', '连续恢复后应回到最后的值');
	assert.deepEqual((await revert([stepB.id, stepC.id])).map((r) => r.ok), [true, true]);
	assert.equal(await nameOf(alice.id), 'frank');

	// 多选中某一条被拒绝时，其余条目照常执行。
	await op(sql({ database: acting }).update('base_users', { name: 'mixed' }, { id: alice.id }));
	const mixedEntry = await latestEntry();
	const mixed = await revert([mixedEntry.id, erinEntry.id]);
	assert.equal(mixed.find((r) => r.id === mixedEntry.id).ok, true);
	assert.equal(mixed.find((r) => r.id === erinEntry.id).ok, false);
	assert.equal(await nameOf(alice.id), 'frank');

	assert.deepEqual(await revert(['999999']), [{ id: '999999', ok: false, message: '审计记录不存在或无权访问' }]);

	// 撤回软删除后回到未删除；再翻回来时 deleted_at 写回**原时间戳**而不是当前时间。
	const deletedAtOf = async () => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }))).deleted_at;
	await op(sql({ database: acting }).softDelete('base_users', { id: alice.id }));
	const deleteEntry = await latestEntry();
	const deletedAt = await deletedAtOf();
	assert.equal(deleteEntry.action, 'soft_delete');
	assert.ok(Number(deletedAt) > 0);
	const beforeFlip = (await entries()).length;
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0, '撤回软删除后记录应回到未删除');
	assert.equal((await entries()).length, beforeFlip, '撤回软删除不产生新记录');
	assert.equal(await statusOf(deleteEntry.id), 'reverted');
	assert.equal((await restore([deleteEntry.id]))[0].ok, true);
	assert.equal(String(await deletedAtOf()), String(deletedAt), '恢复删除应写回原时间戳，而不是当前时间');
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0);

	// ---- 凭证列：照常记录、照常撤回，只是接口不返回值（§5）----
	// 凭证与账号资料分表；password 是 JSON 列（存 { hash, pattern }），前后值都记成对象。
	await runSql(acting, sql({ database: acting }).insert('base_user_credentials', { user_id: alice.id, password: { hash: 'hash-1', pattern: 'LLLL' } }));
	await op(sql({ database: acting }).update('base_user_credentials', { password: { hash: 'hash-2', pattern: 'LLLL' } }, { user_id: alice.id }));
	const passwordEntry = await latestEntry();
	const storedChanges = parseAuditChanges(passwordEntry.changes);
	assert.deepEqual(storedChanges.password, { before: { hash: 'hash-1', pattern: 'LLLL' }, after: { hash: 'hash-2', pattern: 'LLLL' } }, '存储层照常记录凭证前后值，且按 JSON 列的形态记');
	assert.deepEqual(publicAuditChanges(storedChanges), { password: { hidden: true } }, '接口不得返回凭证值');
	assert.equal((await revert([passwordEntry.id]))[0].ok, true, '凭证列仍然可以撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_user_credentials', columns: { password: 'password' }, where: [{ column: 'user_id', value: alice.id }] }))).password, '{"hash":"hash-1","pattern":"LLLL"}', '撤回后凭证应还原');

	// 多列一起改时，摘要一列一行，不挤在一行里。
	const { describeAuditChanges } = await import(pathToFileURL(moduleFile));
	assert.equal(
		describeAuditChanges({ name: { before: 'a', after: 'b' }, status: { before: 'enabled', after: 'disabled' } }),
		'name：a → b\nstatus：enabled → disabled',
	);
	assert.equal(describeAuditChanges({ password: { before: 'x', after: 'y' } }), 'password：已变更', '凭证列只说已变更');
	assert.equal(describeAuditChanges({ roles: { before: [], after: ['a', 'b'] } }), 'roles：[] → ["a","b"]', '数组按 JSON 显示');

	// ---- 审批（§11）----
	// 默认不勾「立即生效」：记录成待审批，数据一条都不动。
	const pendingContext = context('申请调整角色', false);
	const beforePending = (await entries()).length;
	const { PendingApprovalError } = await import(pathToFileURL(moduleFile));
	await assert.rejects(
		() => runOperationSql(pendingContext, acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })),
		(error) => error instanceof PendingApprovalError,
		'不勾立即生效就该走审批，而不是直接写库',
	);
	let pendingEntry = await latestEntry();
	assert.equal((await entries()).length, beforePending + 1, '待审批也要留记录');
	assert.equal(pendingEntry.status, 'pending');
	assert.equal(pendingEntry.reason, '申请调整角色');
	const rolesOf = async () => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles;
	const originalRoles = '[]';
	assert.equal(await rolesOf(), originalRoles, '待审批期间数据一条都不能动');

	// 同一个人对同一条记录再提交一次：覆盖自己那条待审批记录，不再排一条。
	const beforeResubmit = (await entries()).length;
	await assert.rejects(() => runOperationSql(context('改主意了，换成分站管理员', false), acting, sql({ database: acting }).update('base_users', { roles: '["branch_admin"]' }, { id: alice.id })));
	assert.equal((await entries()).length, beforeResubmit, '同一个人对同一行重复提交不该堆出多条待审批记录');
	const resubmitted = await entryById(pendingEntry.id);
	assert.equal(resubmitted.reason, '改主意了，换成分站管理员', '待审批记录被覆盖成最新一版');
	assert.deepEqual(JSON.parse(resubmitted.changes).roles, { before: [], after: ['branch_admin'] });
	// 换个人提交同一行：那是另一件事，各排各的队。
	const otherActor = withDatabaseActors(counting, { subjectRoles: ['platform_admin'], humanOperation: true, base: '99' });
	await assert.rejects(() => runOperationSql(context('另一个人的申请', false), otherActor, sql({ database: otherActor }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));
	assert.equal((await entries()).length, beforeResubmit + 1, '不同操作者的申请各排各的队');
	await transitionAuditEntries(acting, [(await latestEntry()).id], 'rejected', '清理测试数据');
	// 把这条改回原先的值，后面的断言接得上。
	await assert.rejects(() => runOperationSql(context('申请调整角色', false), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));

	// 先提交待审批、再用「立即生效」改同一行：作废的申请被覆盖，不留孤儿记录。
	const beforeSupersede = (await entries()).length;
	await runOperationSql(context('这次直接生效', true), acting, sql({ database: acting }).update('base_users', { roles: '["platform_support"]' }, { id: alice.id }));
	assert.equal((await entries()).length, beforeSupersede, '立即生效应覆盖自己那条待审批记录，而不是再插一条');
	const superseded = await entryById(pendingEntry.id);
	assert.equal(superseded.status, 'applied');
	assert.equal(superseded.reason, '这次直接生效');
	assert.equal(superseded.reviewed_at, null, '立即生效不是审批，不该伪造审批时间');
	assert.equal(await rolesOf(), '["platform_support"]');
	// 复位，后面的断言接得上。
	await runOperationSql(context('复位', true), acting, sql({ database: acting }).update('base_users', { roles: originalRoles }, { id: alice.id }));
	await assert.rejects(() => runOperationSql(context('申请调整角色', false), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));
	pendingEntry = await latestEntry();

	// 待审批的记录不能撤回，只能批准或驳回。
	assert.equal((await revert([pendingEntry.id]))[0].message, '当前状态是「待审批」，不能执行这个操作');

	// 批准：把 after 写进去，并记下审批人与意见。
	assert.deepEqual(await transitionAuditEntries(acting, [pendingEntry.id], 'applied', '同意'), [{ id: pendingEntry.id, ok: true, message: '已批准' }]);
	assert.equal(await rolesOf(), '["tenant_admin"]', '批准后修改才生效');
	const approved = await entryById(pendingEntry.id);
	assert.equal(approved.status, 'applied');
	assert.equal(approved.review_reason, '同意');
	assert.ok(Number(approved.reviewed_at) > 0, '要记下什么时候批的');
	assert.equal(approved.revert_reason, '', '审批与撤回各用一组字段，不能互相覆盖');

	// 批准过的可以再撤回，撤回信息不会覆盖掉「谁批准的」。
	assert.equal((await revert([pendingEntry.id], '批错了'))[0].ok, true);
	const afterRevert = await entryById(pendingEntry.id);
	assert.equal(afterRevert.review_reason, '同意', '撤回不能覆盖审批意见');
	assert.equal(afterRevert.revert_reason, '批错了');
	assert.equal(afterRevert.restore_reason, '', '三组字段互不干扰');
	assert.equal(await rolesOf(), originalRoles);

	// 驳回：不碰数据，只落状态。
	await assert.rejects(() => runOperationSql(context('申请改名', false), acting, sql({ database: acting }).update('base_users', { name: 'rejected-name' }, { id: alice.id })));
	const rejectEntry = await latestEntry();
	assert.deepEqual(await transitionAuditEntries(acting, [rejectEntry.id], 'rejected', '不同意'), [{ id: rejectEntry.id, ok: true, message: '已驳回' }]);
	assert.equal(await nameOf(alice.id), 'frank', '驳回不该改动数据');
	assert.equal((await entryById(rejectEntry.id)).status, 'rejected');
	// 驳回是终态，不能再迁移。
	assert.equal((await transitionAuditEntries(acting, [rejectEntry.id], 'applied'))[0].message, '当前状态是「已驳回」，不能执行这个操作');

	// 非管理员就算发了 X-Change-Immediate 也照样进队列：放行由服务端角色说了算。
	const forged = { req: context('', true).req, get: (key) => key === 'effectiveRoles' ? ['user'] : undefined, set: () => {} };
	await assert.rejects(
		() => runOperationSql(forged, acting, sql({ database: acting }).update('base_users', { name: 'forged' }, { id: alice.id })),
		(error) => error instanceof PendingApprovalError,
		'非管理员伪造请求头不能跳过审批',
	);
	assert.equal(await nameOf(alice.id), 'frank');
	await transitionAuditEntries(acting, [(await latestEntry()).id], 'rejected', '清理测试数据');

	// 列表支持按状态、数据表、记录与原因关键字筛选。
	const { listAuditEntries } = await import(pathToFileURL(moduleFile));
	const pendingOnly = await listAuditEntries(acting, [{ column: 'status', value: 'pending' }]);
	assert.ok(pendingOnly.every((entry) => entry.status === 'pending'), '按状态筛选');
	const byTable = await listAuditEntries(acting, [{ column: 'table_name', value: 'base_users' }]);
	assert.ok(byTable.length && byTable.every((entry) => entry.table_name === 'base_users'), '按数据表筛选');
	// 匹配的是提交时填的「操作原因」，不含撤回理由与审批意见——那两个各有自己的列。
	const byReason = await listAuditEntries(acting, [], '批量调整');
	assert.ok(byReason.length && byReason.every((entry) => entry.reason.includes('批量调整')), '按原因模糊匹配');
	assert.deepEqual(await listAuditEntries(acting, [], '这段文字不存在'), []);
	// 「全部」用显式哨兵值：空串在 antd 的 Select 里等于「没有选中」，选完会显示成空白。
	const auditRoute = await readFile(resolve(projectDirectory, 'server/routes/base/api/panel/admin/base/audit.mts'), 'utf8');
	assert.match(auditRoute, /ALL_STATUS = 'all'/);
	assert.doesNotMatch(auditRoute, /\{ value: '', text: '全部' \}/);
	await auditRouteFilter();

	// ---- 保留期（§10）----
	const total = (await entries()).length;
	assert.equal(await purgeExpiredAuditEntries(database, 0), 0, '保留期为 0 表示不自动清理');
	assert.equal((await entries()).length, total);
	const oldest = (await entries()).slice(0, 3).map((entry) => entry.id);
	const staleAt = Date.now() - 400 * 86400_000;
	for (const id of oldest) database.prepare('UPDATE base_audit_entries SET created_at = ? WHERE id = ?').bind(staleAt, id).run();
	assert.equal(await purgeExpiredAuditEntries(database, 365, { batchSize: 2 }), 3, '过期记录应被物理删除，且分批可重入');
	assert.equal((await entries()).length, total - 3, '未到期的记录不受影响');
	assert.equal(await purgeExpiredAuditEntries(database, 365), 0, '再跑一次没有可清理的记录');

	// 保留期按租户独立：读各租户自己的站点设置。
	await runSql(database, sql({ database }).ignoreInsert('base_tenants', ['key'], { key: 'default', name: '默认租户', status: 'enabled' }));
	const remaining = (await entries()).find((entry) => String(entry.owner_tid) === '1');
	database.prepare('UPDATE base_audit_entries SET created_at = ? WHERE id = ?').bind(staleAt, remaining.id).run();
	assert.equal(await purgeAuditRetention(database), 1, '未配置保留期的租户应回落到默认的 365 天');

	console.log('change audit ok');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
