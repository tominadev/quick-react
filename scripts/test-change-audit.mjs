import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const projectDirectory = resolve(import.meta.dirname, '..');
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
	const { allSql, createSqliteAdapter, firstSql, parseAuditChanges, publicAuditChanges, purgeAuditRetention, purgeExpiredAuditEntries, revertAuditEntries, runOperationSql, runSql, sql, withDatabaseActors } = await import(pathToFileURL(moduleFile));

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
	const context = (reason) => ({ req: { json: async () => (reason === undefined ? {} : { _reason: reason }) } });
	const op = (statement, options) => runOperationSql(context(), acting, statement, options);

	const entries = async () => (await allSql(acting, sql({ database: acting }).select({ table: 'base_audit_entries', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }))).map((entry) => ({ ...entry, id: String(entry.id) }));
	const changesOf = (entry) => JSON.parse(entry.changes);
	const latestEntry = async () => (await entries()).at(-1);

	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'alice', password: 'hash-1', roles: '[]', status: 'enabled' }));
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
	await runOperationSql(context('表单里填的原因'), acting, sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await latestEntry()).reason, '表单里填的原因');
	await op(sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: alice.id }));

	// 提交未改动的字段不产生噪音，全部未变化时不产生记录。
	const beforeNoop = (await entries()).length;
	await op(sql({ database: acting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }));
	assert.equal((await entries()).length, beforeNoop, '逐列一致时不应产生记录');

	// ---- 一次操作可以包含多条写入，它们共享同一个 operation_id 与同一条原因 ----
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'bob', password: 'x', roles: '[]', status: 'disabled' }));
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
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'temp', password: 'x', roles: '[]', status: 'enabled' }));
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
	const failing = withDatabaseActors({ ...database, prepare: (query) => query.includes('base_audit_entries') ? { bind: () => ({ run: async () => { throw new Error('audit write failed'); } }) } : database.prepare(query) }, { subjectRoles: ['platform_admin'], humanOperation: true });
	await assert.rejects(
		() => runOperationSql(context(), failing, sql({ database: failing }).update('base_users', { name: 'alice-4' }, { id: alice.id })),
		/audit write failed/,
		'审计写不进去时整个操作必须失败',
	);
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: alice.id }] }))).name, 'alice-3', '审计失败后业务数据不应被改动');

	// ---- 撤回（§7）----
	const nameOf = async (id) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: id }], deleted: 'all' }))).name;
	const statusOf = async (entryId) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_audit_entries', columns: { status: 'status' }, where: [{ column: 'id', value: entryId }] }))).status;
	const revert = (ids, reason = '') => revertAuditEntries(acting, ids, reason);
	const entryById = async (id) => (await entries()).find((entry) => entry.id === id);

	// 撤回不新开记录，而是把这一条翻到另一面。
	await op(sql({ database: acting }).update('base_users', { name: 'dave' }, { id: alice.id }));
	const daveEntry = await latestEntry();
	const beforeRevert = (await entries()).length;
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
	assert.deepEqual(await revert([daveEntry.id], '恢复：撤错了'), [{ id: daveEntry.id, ok: true, message: '已恢复' }]);
	assert.equal(await nameOf(alice.id), 'dave', '恢复后应回到变更后的值');
	assert.equal(await statusOf(daveEntry.id), 'applied');
	assert.equal((await entries()).length, beforeRevert, '恢复同样不产生新记录');
	assert.equal((await entryById(daveEntry.id)).revert_reason, '恢复：撤错了', '只留最后一次翻转');
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
	const restored = await revert([stepC.id, stepB.id]);
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
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(String(await deletedAtOf()), String(deletedAt), '恢复删除应写回原时间戳，而不是当前时间');
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0);

	// ---- 凭证列：照常记录、照常撤回，只是接口不返回值（§5）----
	await op(sql({ database: acting }).update('base_users', { password: 'hash-2' }, { id: alice.id }));
	const passwordEntry = await latestEntry();
	const storedChanges = parseAuditChanges(passwordEntry.changes);
	assert.deepEqual(storedChanges.password, { before: 'hash-1', after: 'hash-2' }, '存储层照常记录凭证前后值');
	assert.deepEqual(publicAuditChanges(storedChanges), { password: { hidden: true } }, '接口不得返回凭证值');
	assert.equal((await revert([passwordEntry.id]))[0].ok, true, '凭证列仍然可以撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { password: 'password' }, where: [{ column: 'id', value: alice.id }] }))).password, 'hash-1', '撤回后凭证应还原');

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
