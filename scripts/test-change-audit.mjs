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
		stdin: { contents: "export * from './server/database/sql.mts'; export * from './server/database/sqlite.mts'; export * from './server/modules/base/audit.mts';", resolveDir: projectDirectory, sourcefile: 'audit-test-entry.mts' },
		bundle: true, format: 'esm', platform: 'node', write: false,
	});
	const moduleFile = join(temporaryDirectory, 'audit.mjs');
	await writeFile(moduleFile, result.outputFiles[0].contents);
	const { allSql, createSqliteAdapter, firstSql, parseAuditChanges, publicAuditChanges, purgeAuditRetention, purgeExpiredAuditEntries, revertAuditEntries, runSql, sql } = await import(pathToFileURL(moduleFile));

	const database = createSqliteAdapter(join(temporaryDirectory, 'audit.sqlite'));
	const migrations = resolve(projectDirectory, 'migrations/base');
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
		await database.exec(await readFile(resolve(migrations, file), 'utf8'));
	}

	// 统计准备的语句，用来验证心跳写入不产生额外读取（§3.3）。
	let prepared = [];
	const counting = { ...database, prepare: (query) => { prepared.push(query); return database.prepare(query); } };
	const reset = () => { prepared = []; };

	// id 统一成字符串：模块接口一律 cast 成文本（雪花号按数字读会溢出），断言要对得上。
	const entries = async () => (await allSql(counting, sql({ database: counting }).select({ table: 'base_audit_entries', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }))).map((entry) => ({ ...entry, id: String(entry.id) }));
	const changesOf = (entry) => JSON.parse(entry.changes);

	await runSql(database, sql({ database }).insert('base_users', { name: 'alice', password: 'hash-1', roles: '[]', status: 'enabled' }));
	const alice = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: 'alice' }] }));

	// 新增不产生审计条目（§3.0）。
	assert.equal((await entries()).length, 0, '新增不应产生审计条目');

	// 受管表的业务字段变更产生一条记录，且只包含实际变化的列。
	reset();
	await runSql(counting, sql({ database: counting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }));
	let all = await entries();
	assert.equal(all.length, 1);
	assert.equal(all[0].table_name, 'base_users');
	assert.equal(String(all[0].row_id), String(alice.id));
	assert.equal(all[0].action, 'update');
	assert.equal(all[0].status, 'applied');
	assert.deepEqual(changesOf(all[0]), { name: { before: 'alice', after: 'alice-2' } }, '未变化的 status 不应出现在 changes 里');
	assert.ok(prepared.some((query) => query.startsWith('SELECT')), '业务变更要读一次原行');

	// 提交未改动的字段不产生噪音，全部未变化时不产生记录。
	await runSql(database, sql({ database }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }));
	assert.equal((await entries()).length, 1, '逐列一致时不应产生记录');

	// 只碰排除列的更新在生成语句时就短路：不带元信息，因此 runSql 不读原行、不产生记录（§3.3）。
	// 当前受管表都还没有心跳列（文档举的 sms_shortcut_tokens.last_used_at 尚未建表），
	// 因此在构建层断言，这正是短路发生的地方。
	assert.equal(sql({ database }).update('base_users', { last_seen_at: 1 }, { id: alice.id }).audit, undefined, '只碰心跳列不应附带审计元信息');
	assert.equal(sql({ database }).update('base_sessions', { token_hash: 'x' }, { id: 1 }).audit, undefined, '未审计表不应附带审计元信息');
	assert.ok(sql({ database }).update('base_users', { name: 'x' }, { id: alice.id }).audit, '业务列变更必须附带审计元信息');
	assert.equal(sql({ database }).insert('base_users', { name: 'x', password: 'y', roles: '[]', status: 'enabled' }).audit, undefined, '新增不附带审计元信息');

	// 白名单外的表任何写入都不产生记录。
	await runSql(database, sql({ database }).insert('base_sessions', { token_hash: 'token-1', user_id: alice.id, device_id: 1, expires_at: 1 }));
	await runSql(database, sql({ database }).update('base_sessions', { token_hash: 'token-2' }, { user_id: alice.id }));
	assert.equal((await entries()).length, 1, '未审计表的写入不应产生记录');

	// 软删除与恢复各产生一条记录，action 分别为 soft_delete 与 restore。
	await runSql(database, sql({ database }).softDelete('base_users', { id: alice.id }));
	await runSql(database, sql({ database }).restore('base_users', { id: alice.id }));
	all = await entries();
	assert.equal(all.length, 3);
	assert.equal(all[1].action, 'soft_delete');
	assert.equal(Number(changesOf(all[1]).deleted_at.before), 0);
	assert.ok(Number(changesOf(all[1]).deleted_at.after) > 0);
	assert.equal(all[2].action, 'restore');
	assert.equal(Number(changesOf(all[2]).deleted_at.after), 0);

	// 物理删除不产生记录。
	await runSql(database, sql({ database }).insert('base_users', { name: 'temp', password: 'x', roles: '[]', status: 'enabled' }));
	await runSql(database, sql({ database }).delete('base_users', { name: 'temp' }));
	assert.equal((await entries()).length, 3, '物理删除不应产生记录');

	// 操作者与归属：created_duid 是真实操作者，owner_uid 是作用账号（§4.1）。
	const delegated = sql({ database, actorUid: '77', ownerUid: '42', ownerTid: '3', ownerBid: '5' });
	await runSql(database, delegated.update('base_users', { name: 'alice-3' }, { id: alice.id }));
	const delegatedEntry = (await entries()).at(-1);
	assert.equal(String(delegatedEntry.created_duid), '77', 'created_duid 应是客服的 device-user');
	assert.equal(String(delegatedEntry.owner_uid), '42', 'owner_uid 应是被代查的账号');
	assert.equal(String(delegatedEntry.owner_tid), '3');
	assert.equal(String(delegatedEntry.owner_bid), '5');

	// 一次更新命中多行时，每行各产生一条记录。
	await runSql(database, sql({ database }).insert('base_users', { name: 'bob', password: 'x', roles: '[]', status: 'disabled' }));
	await runSql(database, sql({ database }).insert('base_users', { name: 'carol', password: 'x', roles: '[]', status: 'disabled' }));
	const before = (await entries()).length;
	await runSql(database, sql({ database }).update('base_users', { status: 'enabled' }, [{ column: 'status', value: 'disabled' }]));
	const afterEntries = await entries();
	assert.equal(afterEntries.length, before + 2, '命中两行应各产生一条记录');
	assert.deepEqual(new Set(afterEntries.slice(-2).map((entry) => String(entry.row_id))).size, 2);

	// 审计写入失败时，业务写入一并失败（§6.2）。
	const failing = { ...database, prepare: (query) => query.includes('base_audit_entries') ? { bind: () => ({ run: async () => { throw new Error('audit write failed'); } }) } : database.prepare(query) };
	await assert.rejects(
		() => runSql(failing, sql({ database: failing }).update('base_users', { name: 'alice-4' }, { id: alice.id })),
		/audit write failed/,
		'审计写不进去时整个操作必须失败',
	);
	const unchanged = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: alice.id }] }));
	assert.equal(unchanged.name, 'alice-3', '审计失败后业务数据不应被改动');

	// upsert 的 UPDATE 分支要留痕：站点设置、系统配置都是这么写进 base_configs 的。
	const upsertConfig = (value) => sql({ database }).upsert('base_configs', ['key', 'owner_tid'], { key: 'site-settings', value }, ['value', 'updated_at']);
	await runSql(database, upsertConfig('{"footer":"one"}'));
	const afterConfigInsert = (await entries()).length;
	assert.equal(sql({ database }).upsert('base_configs', ['key', 'owner_tid'], { key: 'k', value: 'v' }, ['value']).audit?.table, 'base_configs');
	await runSql(database, upsertConfig('{"footer":"two"}'));
	const configEntry = (await entries()).at(-1);
	assert.equal((await entries()).length, afterConfigInsert + 1, '新插入的配置行不留痕，冲突改写才留痕');
	assert.equal(configEntry.table_name, 'base_configs');
	assert.deepEqual(changesOf(configEntry), { value: { before: '{"footer":"one"}', after: '{"footer":"two"}' } });
	// value 是凭证列：存了值，但接口只返回"已变更"。
	assert.deepEqual(publicAuditChanges(changesOf(configEntry)), { value: { hidden: true } });
	await runSql(database, upsertConfig('{"footer":"two"}'));
	assert.equal((await entries()).length, afterConfigInsert + 1, '值没变的 upsert 不产生记录');

	// ---- 撤回（§7）----
	const nameOf = async (id) => (await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: id }], deleted: 'all' }))).name;
	const statusOf = async (entryId) => (await firstSql(database, sql({ database }).select({ table: 'base_audit_entries', columns: { status: 'status' }, where: [{ column: 'id', value: entryId }] }))).status;
	const latestEntry = async () => (await entries()).at(-1);

	// 撤回 update 后字段恢复原值；撤回产生一条新记录，原记录 status 变为 reverted。
	await runSql(database, sql({ database }).update('base_users', { name: 'dave' }, { id: alice.id }));
	const daveEntry = await latestEntry();
	const beforeRevert = (await entries()).length;
	assert.deepEqual(await revertAuditEntries(database, [daveEntry.id]), [{ id: daveEntry.id, ok: true, message: '已撤回：update' }]);
	assert.equal(await nameOf(alice.id), 'alice-3', '撤回后字段应恢复原值');
	assert.equal(await statusOf(daveEntry.id), 'reverted');
	assert.equal((await entries()).length, beforeRevert + 1, '撤回本身也要留一条记录');

	// 再次撤回同一条被拒绝。
	assert.deepEqual(await revertAuditEntries(database, [daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '该记录已经撤回过' }]);

	// 要还原的列在变更之后又被改过时，撤回被拒绝且数据不变。
	await runSql(database, sql({ database }).update('base_users', { name: 'erin' }, { id: alice.id }));
	const erinEntry = await latestEntry();
	await runSql(database, sql({ database }).update('base_users', { name: 'frank' }, { id: alice.id }));
	const rejected = await revertAuditEntries(database, [erinEntry.id]);
	assert.equal(rejected[0].ok, false);
	assert.match(rejected[0].message, /已被后续修改覆盖/);
	assert.equal(await nameOf(alice.id), 'frank', '撤回被拒绝时数据不变');
	assert.equal(await statusOf(erinEntry.id), 'applied', '被拒绝的记录不应标记为已撤回');

	// 同一行上与本次变更无关的列被改过，不影响撤回。
	await runSql(database, sql({ database }).update('base_users', { name: 'grace' }, { id: alice.id }));
	const graceEntry = await latestEntry();
	await runSql(database, sql({ database }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await revertAuditEntries(database, [graceEntry.id]))[0].ok, true, '无关列被改动不应挡住撤回');
	assert.equal(await nameOf(alice.id), 'frank');

	// 同一列的两次连续变更：倒序撤回全部成功，数据回到最初值。
	await runSql(database, sql({ database }).update('base_users', { name: 'step-b' }, { id: alice.id }));
	const stepB = await latestEntry();
	await runSql(database, sql({ database }).update('base_users', { name: 'step-c' }, { id: alice.id }));
	const stepC = await latestEntry();
	// 传入顺序故意写反，实现必须按 created_at 降序重排后执行（§8）。
	const chained = await revertAuditEntries(database, [stepB.id, stepC.id]);
	assert.deepEqual(chained.map((result) => result.ok), [true, true], '链式变更倒序撤回应全部成功');
	assert.equal(chained[0].id, stepC.id, '执行顺序必须是从新到旧');
	assert.equal(await nameOf(alice.id), 'frank', '连续撤回后应回到最初值');

	// 多选中某一条被拒绝时，其余条目照常执行。
	await runSql(database, sql({ database }).update('base_users', { name: 'mixed' }, { id: alice.id }));
	const mixedEntry = await latestEntry();
	const mixed = await revertAuditEntries(database, [mixedEntry.id, erinEntry.id]);
	assert.equal(mixed.find((result) => result.id === mixedEntry.id).ok, true);
	assert.equal(mixed.find((result) => result.id === erinEntry.id).ok, false);
	assert.equal(await nameOf(alice.id), 'frank');

	// 不存在或无权访问的记录逐条报告，不影响其余条目。
	assert.deepEqual(await revertAuditEntries(database, ['999999']), [{ id: '999999', ok: false, message: '审计记录不存在或无权访问' }]);

	// 撤回软删除后记录回到未删除；撤回恢复后回到已删除，且还原的是原时间戳。
	await runSql(database, sql({ database }).softDelete('base_users', { id: alice.id }));
	const deleteEntry = await latestEntry();
	const deletedAt = (await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }))).deleted_at;
	assert.ok(Number(deletedAt) > 0);
	assert.equal((await revertAuditEntries(database, [deleteEntry.id]))[0].ok, true);
	const afterUndelete = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }));
	assert.equal(Number(afterUndelete.deleted_at), 0, '撤回软删除后记录应回到未删除');
	const undeleteEntry = await latestEntry();
	assert.equal(undeleteEntry.action, 'restore', '撤回软删除产生的是一条 restore 记录');
	assert.equal((await revertAuditEntries(database, [undeleteEntry.id]))[0].ok, true);
	const afterRedelete = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }));
	assert.equal(String(afterRedelete.deleted_at), String(deletedAt), '撤回恢复应写回原时间戳，而不是当前时间');
	await runSql(database, sql({ database }).restore('base_users', { id: alice.id }));

	// 凭证列照常记录、照常撤回，但接口不返回它的前后值（§5）。
	await runSql(database, sql({ database }).update('base_users', { password: 'hash-2' }, { id: alice.id }));
	const passwordEntry = await latestEntry();
	const storedChanges = parseAuditChanges(passwordEntry.changes);
	assert.deepEqual(storedChanges.password, { before: 'hash-1', after: 'hash-2' }, '存储层照常记录凭证前后值');
	assert.deepEqual(publicAuditChanges(storedChanges), { password: { hidden: true } }, '接口不得返回凭证值');
	assert.equal((await revertAuditEntries(database, [passwordEntry.id]))[0].ok, true, '凭证列仍然可以撤回');
	const restoredPassword = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { password: 'password' }, where: [{ column: 'id', value: alice.id }] }));
	assert.equal(restoredPassword.password, 'hash-1', '撤回后凭证应还原');

	// ---- 保留期（§10）----
	const total = (await entries()).length;
	assert.equal(await purgeExpiredAuditEntries(database, 0), 0, '保留期为 0 表示不自动清理');
	assert.equal((await entries()).length, total);
	// 把一半记录的时间推到 400 天前，只有它们应该被清掉。
	const oldest = (await entries()).slice(0, 3).map((entry) => entry.id);
	const staleAt = Date.now() - 400 * 86400_000;
	for (const id of oldest) database.prepare('UPDATE base_audit_entries SET created_at = ? WHERE id = ?').bind(staleAt, id).run();
	assert.equal(await purgeExpiredAuditEntries(database, 365, { batchSize: 2 }), 3, '过期记录应被物理删除，且分批可重入');
	assert.equal((await entries()).length, total - 3, '未到期的记录不受影响');
	assert.equal(await purgeExpiredAuditEntries(database, 365), 0, '再跑一次没有可清理的记录');

	// 保留期按租户独立：读各租户自己的站点设置。
	await runSql(database, sql({ database }).ignoreInsert('base_tenants', ['key'], { key: 'default', name: '默认租户', status: 'enabled' }));
	// 挑一条属于默认租户的记录：代用户那条落在 owner_tid=3，不在这次清理范围内。
	const remaining = (await entries()).find((entry) => String(entry.owner_tid) === '1');
	database.prepare('UPDATE base_audit_entries SET created_at = ? WHERE id = ?').bind(staleAt, remaining.id).run();
	assert.equal(await purgeAuditRetention(database), 1, '未配置保留期的租户应回落到默认的 365 天');

	console.log('change audit ok');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
