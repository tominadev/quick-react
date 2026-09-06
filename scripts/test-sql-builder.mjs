import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'quick-react-sql-builder-'));
try {
	const result = await build({ stdin: { contents: "export * from './server/database/sql.mts'; export { useMemorySnowflake } from './server/modules/base/snowflake.mts'; export * from './server/database/schema.mts'; export * from './server/database/sqlite.mts';", resolveDir: resolve(import.meta.dirname, '..'), sourcefile: 'sql-test-entry.mts' }, bundle: true, format: 'esm', platform: 'node', write: false });
	const file = join(directory, 'sql.mjs'); await writeFile(file, result.outputFiles[0].contents);
	const { useMemorySnowflake, SqliteSqlBuilder, MysqlSqlBuilder, PostgresqlSqlBuilder, addColumn, renameColumn, compileSqlPlaceholders, createSqliteAdapter, synchronizePostgresqlIdentity } = await import(pathToFileURL(file));
	// 单元测试不连库，用内存号段：生产路径一律走 primeSnowflake，那里的原子预留才防得住重启和多进程。
	useMemorySnowflake();
	const sqlite = new SqliteSqlBuilder(), mysql = new MysqlSqlBuilder(), postgres = new PostgresqlSqlBuilder();
	const sqliteInsert = sqlite.insert('users', { name: 'Alice', status: 'enabled' });
	// 没有租户上下文时不写 owner_tid：该列是 NOT NULL DEFAULT 1，交给数据库默认值兜到默认租户。
	// key 由这一层补：每一行都要有稳定标识，调用方给了就用调用方的。
	assert.match(sqliteInsert.query, /^INSERT INTO "users" \("created_at", "updated_at", "owner_uid", "key", "name", "status"\) VALUES \(\?, \?, \?, \?, \?, \?\)$/);
	assert.deepEqual(sqliteInsert.values.slice(4), ['Alice', 'enabled']);
	assert.match(String(sqliteInsert.values[3]), /^\d+$/, 'key 是雪花号');
	assert.equal(sqlite.insert('users', { key: 'given_key', name: 'Alice' }).values[3], 'given_key', '调用方给的 key 不被覆盖');
	assert.throws(() => sqlite.insert('users', { key: '不是英文' }), /只能是英文字母/);
	assert.throws(() => sqlite.insert('users', { key: 'x'.repeat(37) }), /最长 36/);
	// key 建后不改：能被别的表引用，正是因为它不动；改一次就把所有引用指向了空处。
	assert.throws(() => sqlite.update('users', { key: 'new_key' }, { id: 1 }), /系统字段/);
	const actorSql = new SqliteSqlBuilder('17');
	const actorInsert = actorSql.insert('users', { name: 'Alice' });
	assert.match(actorInsert.query, /^INSERT INTO "users" \("created_at", "updated_at", "created_duid", "updated_duid", "owner_uid", "key", "name"\)/);
	assert.deepEqual(actorInsert.values.slice(2, 4), ['17', '17']);
	const ownerSql = new SqliteSqlBuilder(null, 'active', '23', '7');
	const ownerInsert = ownerSql.insert('users', { name: 'Alice' });
	// 绑定了租户就写进去，排在 owner_uid 之前。
	assert.match(ownerInsert.query, /"owner_tid", "owner_uid"/);
	assert.equal(ownerInsert.values[2], '7');
	assert.equal(ownerInsert.values[3], '23');
	assert.doesNotThrow(() => ownerSql.update('users', { owner_uid: '24' }, { id: 1 }));
	const tenantTables = new SqliteSqlBuilder(null, 'active', null, (table) => table.startsWith('passport_') ? 'p-tid' : 'b-tid');
	assert.equal(tenantTables.insert('passport_users', { name: 'A' }).values[2], 'p-tid');
	assert.equal(tenantTables.insert('base_users', { name: 'A' }).values[2], 'b-tid');
	const actorUpdate = actorSql.update('users', { name: 'Bob' }, { id: 1 });
	assert.match(actorUpdate.query, /^UPDATE "users" SET "updated_at" = \?, "updated_duid" = \?, "name" = \?/);
	const tableActors = new SqliteSqlBuilder((table) => table.startsWith('passport_') ? 'passport-duid' : 'base-duid');
	assert.deepEqual(tableActors.update('passport_users', { nickname: 'Bob' }, { id: 1 }).values.slice(1, 2), ['passport-duid']);
	assert.doesNotThrow(() => sqlite.insert('users', { id: 1 }));
	assert.throws(() => sqlite.insert('users', { deleted_at: 1 }), /系统字段/);
	assert.throws(() => sqlite.update('users', { id: 2 }, { id: 1 }), /系统字段/);
	assert.throws(() => sqlite.update('users', { deleted_at: 1 }, { id: 1 }), /系统字段/);
	/**
	 * ON CONFLICT 的目标列要与库里那条唯一索引逐列对上。
	 *
	 * **只有 `name` 参与的唯一索引带 `deleted_at`**：名字是人取的，删掉一行之后同一个名字
	 * 该能再用。其余一律不带——它们要么是系统生成、永不重复的标识（雪花号 key、各种 hash、
	 * token），要么是外部给的稳定标识，`deleted_at` 在那里纯属多余。
	 */
	assert.match(sqlite.upsert('sessions', ['issuer', 'sid'], { issuer: 'i', sid: 's', session_id: 'x' }, ['session_id']).query, /ON CONFLICT \("issuer", "sid"\) DO UPDATE/);
	assert.match(sqlite.upsert('tenants', ['name'], { name: 'a', title: 'b' }, ['title']).query, /ON CONFLICT \("name", "deleted_at"\) DO UPDATE/, 'name 是人取的，软删之后要能重建同名');
	assert.match(sqlite.ignoreInsert('configs', ['key', 'owner_tid'], { key: 'k' }).query, /ON CONFLICT \("key", "owner_tid"\) DO NOTHING/, 'key 当 id 一样用，不带 deleted_at');
	assert.match(mysql.upsert('sessions', ['issuer', 'sid'], { issuer: 'i', sid: 's', session_id: 'x' }, ['session_id']).query, /ON DUPLICATE KEY UPDATE `session_id` = VALUES\(`session_id`\)/);
	assert.match(mysql.ignoreInsert('users', ['name'], { name: 'Alice' }).query, /^INSERT IGNORE/);
	const postgresInsert = postgres.insert('users', { name: 'Alice', status: 'enabled' });
	assert.match(postgresInsert.query, /^INSERT INTO "users" \("created_at", "updated_at", "owner_uid", "key", "name", "status"\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)$/);
	assert.deepEqual(postgresInsert.values.slice(4), ['Alice', 'enabled']);
	assert.deepEqual(postgres.count('users', [{ column: 'status', value: 'enabled' }]), { query: 'SELECT COUNT(*) AS "count" FROM "users" WHERE "deleted_at" = $1 AND "queued_at" = $2 AND "status" = $3', values: [0, 0, 'enabled'] });
	// 计数跟着适配器的作用域走，和 select 用同一个默认值。原先这里写死了 'active'：
	// 翻回收站时列表读的是已删除的那些行，页脚报的却是主表的总数——列表七条、底下写着共 231 条。
	const binBuilder = new SqliteSqlBuilder(null, 'deleted');
	assert.deepEqual(binBuilder.count('users'), { query: 'SELECT COUNT(*) AS "count" FROM "users" WHERE "deleted_at" != ?', values: [0] });
	assert.equal(binBuilder.select({ table: 'users', includeAll: true }).query, 'SELECT * FROM "users" WHERE "users"."deleted_at" != ?', '与 count 同一组条件');
	assert.equal(new SqliteSqlBuilder(null, 'all').count('users').query, 'SELECT COUNT(*) AS "count" FROM "users"');
	assert.equal(binBuilder.count('users', [], 'active').query, 'SELECT COUNT(*) AS "count" FROM "users" WHERE "deleted_at" = ? AND "queued_at" = ?', '显式指定仍然压过默认');

	// —— 搜索框的三态换成 WHERE 条件 ——
	// 没这个参数是不筛选，空串是「填了，找空的」，有值才按值筛。压成两态就搜不出空值了。
	assert.deepEqual(sqlite.search('reason', undefined), []);
	assert.deepEqual(sqlite.search('reason', '改密码'), [{ column: 'reason', value: '改密码' }]);
	assert.deepEqual(sqlite.search('reason', '改密码', 'like'), [{ column: 'reason', operator: 'LIKE', value: '%改密码%' }]);
	// 空串匹配 NULL 与空串两种存储形态：文本框只有「未填写」和「空」两个可表达的状态，
	// 而「未填写」已经占去了「不筛选」。这是问法上的合并，列表里两者照旧分得开。
	assert.deepEqual(sqlite.search('reason', ''), [{ raw: `("reason" IS NULL OR "reason" = '')` }]);
	assert.deepEqual(postgres.search('reason', ''), [{ raw: `("reason" IS NULL OR "reason" = '')` }]);
	assert.deepEqual(mysql.search('reason', ''), [{ raw: "(`reason` IS NULL OR `reason` = '')" }]);
	// 空串条件不带占位符，接进 select 之后后面的参数编号不能被它挤歪。
	assert.deepEqual(postgres.select({ table: 'users', includeAll: true, where: [...postgres.search('reason', ''), { column: 'status', value: 'enabled' }] }), {
		query: `SELECT * FROM "users" WHERE "users"."deleted_at" = $1 AND "users"."queued_at" = $2 AND ("reason" IS NULL OR "reason" = '') AND "status" = $3`,
		values: [0, 0, 'enabled'],
	});
	assert.deepEqual(mysql.select({ table: 'users', includeAll: true, limit: 10, offset: 20 }), { query: 'SELECT * FROM `users` WHERE `users`.`deleted_at` = ? AND `users`.`queued_at` = ? LIMIT ? OFFSET ?', values: [0, 0, 10, 20] });
	assert.equal(sqlite.select({ table: 'users', includeAll: true, sqliteRowIdAlias: '__rowid__' }).query, 'SELECT rowid AS "__rowid__", * FROM "users" WHERE "users"."deleted_at" = ? AND "users"."queued_at" = ?');
	assert.deepEqual(sqlite.select({ table: 'users', includeAll: true, deleted: 'deleted' }), { query: 'SELECT * FROM "users" WHERE "users"."deleted_at" != ?', values: [0] });
	assert.equal(sqlite.select({ table: 'users', includeAll: true, deleted: 'all' }).query, 'SELECT * FROM "users"');
	assert.match(sqlite.softDelete('users', { id: 1 }).query, /^UPDATE "users" SET "updated_at" = \?, "deleted_at" = \? WHERE "id" = \?$/);
	assert.match(sqlite.restore('users', { id: 1 }).query, /^UPDATE "users" SET "updated_at" = \?, "deleted_at" = \? WHERE "id" = \?$/);
	assert.deepEqual(sqlite.delete('users', [{ column: 'id', value: 1 }, { column: 'deleted_at', operator: '!=', value: 0 }]), { query: 'DELETE FROM "users" WHERE "id" = ? AND "deleted_at" != ?', values: [1, 0] });
	assert.throws(() => postgres.select({ table: 'users', sqliteRowIdAlias: '__rowid__' }), /only available for SQLite/);
	assert.deepEqual(addColumn({ dialect: 'mysql' }, 'users', 'display_name', 'VARCHAR(255)', true, "O'Reilly"), { query: "ALTER TABLE `users` ADD COLUMN `display_name` VARCHAR(255) NOT NULL DEFAULT 'O''Reilly'", values: [] });
	assert.deepEqual(addColumn({ dialect: 'postgresql' }, 'users', 'score', 'numeric', false, 0), { query: 'ALTER TABLE "users" ADD COLUMN "score" NUMERIC DEFAULT 0', values: [] });
	assert.deepEqual(renameColumn({ dialect: 'sqlite' }, 'users', 'name', 'display_name'), { query: 'ALTER TABLE "users" RENAME COLUMN "name" TO "display_name"', values: [] });
	assert.throws(() => addColumn({ dialect: 'postgresql' }, 'users', 'score', 'UNSAFE TYPE', false), /支持的字段类型/);
	assert.deepEqual(mysql.advanceNumber('snowflake_state', 'last_at', 100, 101, { worker_id: 7 }), { query: 'UPDATE `snowflake_state` SET `last_at` = GREATEST(`last_at` + 1, ?), `updated_at` = ? WHERE `worker_id` = ?', values: [100, 101, 7] });
	assert.match(sqlite.advanceNumber('snowflake_state', 'last_at', 100, 101, { worker_id: 7 }).query, /MAX\("last_at" \+ 1, \?\)/);
	assert.deepEqual(postgres.insertFromSelect('sessions', { id: 'session', user_id: { column: 'user_id' }, expires_at: 123 }, 'challenges', [{ column: 'id', value: 'challenge' }, { column: 'status', value: 'approved' }]), { query: 'INSERT INTO "sessions" ("id", "user_id", "expires_at") SELECT $1, "user_id", $2 FROM "challenges" WHERE "id" = $3 AND "status" = $4', values: ['session', 123, 'challenge', 'approved'] });
	assert.match(postgres.upsert('sessions', ['issuer', 'sid'], { issuer: 'i', sid: 's', session_id: 'x' }, ['session_id']).query, /ON CONFLICT \("issuer", "sid"\) DO UPDATE/);
	assert.equal(sqlite.castText('user_id'), 'CAST("user_id" AS TEXT)'); assert.equal(mysql.castText('user_id'), 'CAST(`user_id` AS CHAR)');
	assert.throws(() => sqlite.insert('users; DROP TABLE users', { name: 'x' }), /Unsafe SQL identifier/);
	const mysqlLegacy = compileSqlPlaceholders('SELECT ?2 AS second, ?1 AS first, ?2 AS repeated', 'mysql');
	assert.equal(mysqlLegacy.query, 'SELECT ? AS second, ? AS first, ? AS repeated');
	assert.deepEqual(mysqlLegacy.values(['one', 'two']), ['two', 'one', 'two']);
	const postgresLegacy = compileSqlPlaceholders('SELECT ?2 AS second, ?1 AS first, ?2 AS repeated', 'postgresql');
	assert.equal(postgresLegacy.query, 'SELECT $2 AS second, $1 AS first, $2 AS repeated');
	assert.deepEqual(postgresLegacy.values(['one', 'two']), ['one', 'two']);
	assert.match(synchronizePostgresqlIdentity('users', 'id').query, /pg_get_serial_sequence\(\$1, \$2\)/);
	const bigintDatabase = createSqliteAdapter(join(directory, 'bigint.sqlite'), { readBigInts: true });
	await bigintDatabase.exec('CREATE TABLE values_test (id INTEGER PRIMARY KEY)');
	await bigintDatabase.prepare('INSERT INTO values_test (id) VALUES (?)').bind(9007199254740993n).run();
	assert.equal((await bigintDatabase.prepare('SELECT id FROM values_test').first()).id, 9007199254740993n);
	bigintDatabase.close();
	console.log('sql builder test passed');
} finally { await rm(directory, { recursive: true, force: true }); }
