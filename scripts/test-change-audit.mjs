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
		stdin: { contents: "export * from './server/database/sql.mts'; export * from './server/database/sqlite.mts';", resolveDir: projectDirectory, sourcefile: 'audit-test-entry.mts' },
		bundle: true, format: 'esm', platform: 'node', write: false,
	});
	const moduleFile = join(temporaryDirectory, 'audit.mjs');
	await writeFile(moduleFile, result.outputFiles[0].contents);
	const { allSql, createSqliteAdapter, firstSql, runSql, sql } = await import(pathToFileURL(moduleFile));

	const database = createSqliteAdapter(join(temporaryDirectory, 'audit.sqlite'));
	const migrations = resolve(projectDirectory, 'migrations/base');
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
		await database.exec(await readFile(resolve(migrations, file), 'utf8'));
	}

	// 统计准备的语句，用来验证心跳写入不产生额外读取（§3.3）。
	let prepared = [];
	const counting = { ...database, prepare: (query) => { prepared.push(query); return database.prepare(query); } };
	const reset = () => { prepared = []; };

	const entries = () => allSql(counting, sql({ database: counting }).select({ table: 'base_audit_entries', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }));
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

	console.log('change audit ok');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
