import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const projectDirectory = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [join(projectDirectory, 'scripts', 'verify-prisma-migrations.mjs')], { cwd: projectDirectory, stdio: 'inherit' });

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const dropExtra = args.has('--drop-extra');
const yes = args.has('--yes');
const fileArg = process.argv.find((value) => value.startsWith('--file='))?.slice(7);
const groupsArg = process.argv.find((value) => value.startsWith('--groups='))?.slice(9);
const databaseFile = resolve(fileArg || process.env.DEFAULT_DATABASE_FILE || 'database/default.sqlite');
const groups = (groupsArg || 'global,base,passport,pve').split(',').map((value) => value.trim()).filter(Boolean);
if (dropExtra && !yes) throw new Error('删除多余字段必须同时传入 --yes；请先运行 schema:check 查看差异');

const applyMigrations = async (database) => {
	database.exec('CREATE TABLE IF NOT EXISTS global_schema_migrations (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0, created_duid INTEGER, updated_duid INTEGER, owner_tid INTEGER NOT NULL DEFAULT 1, owner_bid INTEGER NOT NULL DEFAULT 1, owner_uid INTEGER, migration_key TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)');
	for (const group of groups) {
		const directory = resolve('migrations', group);
		const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith('.sql')).sort();
		for (const file of files) {
			const key = `${group}/${file}`;
			if (database.prepare('SELECT 1 FROM global_schema_migrations WHERE migration_key = ?').get(key)) continue;
			database.exec('BEGIN IMMEDIATE');
			try { const now = Date.now(); database.exec(await readFile(join(directory, file), 'utf8')); database.prepare('INSERT INTO global_schema_migrations (created_at, updated_at, migration_key, applied_at) VALUES (?, ?, ?, ?)').run(now, now, key, now); database.exec('COMMIT'); }
			catch (error) { database.exec('ROLLBACK'); throw new Error(`${key} 执行失败：${error instanceof Error ? error.message : error}`); }
		}
	}
};
const tables = (database) => new Map(database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => [row.name, row.sql]));
const columns = (database, table) => new Set(database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name));
/**
 * 建表语句里的 UNIQUE 会生成 sql 为 NULL 的自动索引，这里只比对显式 CREATE INDEX——
 * migrations 里的唯一约束都是独立语句，按名字比对因此是完整的。
 */
const indexes = (database, table) => new Map(database
	.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
	.all(table).map((row) => [row.name, row.sql]));
const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

const rebuildTable = (actual, expected, table, createSql, wanted, present) => {
	const temporaryTable = `__schema_repair_${table}`;
	const temporaryCreate = createSql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i, `CREATE TABLE ${identifier(temporaryTable)}`);
	const retained = [...wanted].filter((column) => present.has(column));
	const indexSql = expected.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table).map((row) => row.sql);
	actual.exec('PRAGMA foreign_keys = OFF');
	actual.exec('BEGIN IMMEDIATE');
	try {
		actual.exec(`DROP TABLE IF EXISTS ${identifier(temporaryTable)}`);
		actual.exec(temporaryCreate);
		if (retained.length) { const fields = retained.map(identifier).join(', '); actual.exec(`INSERT INTO ${identifier(temporaryTable)} (${fields}) SELECT ${fields} FROM ${identifier(table)}`); }
		actual.exec(`DROP TABLE ${identifier(table)}`);
		actual.exec(`ALTER TABLE ${identifier(temporaryTable)} RENAME TO ${identifier(table)}`);
		for (const statement of indexSql) actual.exec(statement);
		actual.exec('COMMIT');
	} catch (error) { actual.exec('ROLLBACK'); throw error; }
	finally { actual.exec('PRAGMA foreign_keys = ON'); }
};

const temporary = await mkdtemp(join(tmpdir(), 'quick-react-schema-'));
const expected = new DatabaseSync(join(temporary, 'expected.sqlite'));
const actual = new DatabaseSync(databaseFile);
try {
	await applyMigrations(expected);
	if (!checkOnly) await applyMigrations(actual);
	const expectedTables = tables(expected), actualTables = tables(actual), differences = [], rebuilds = [];
	// 建表和建索引分开做：漏建索引不会让任何查询报错，只会让唯一性悄悄失效，
	// 直到某次 upsert 撞上「ON CONFLICT clause does not match any ... UNIQUE constraint」
	// 才暴露出来——那时错的是数据，不只是这一次写入。
	const repairIndexes = (table) => {
		const wanted = indexes(expected, table), present = indexes(actual, table);
		for (const [name, createIndexSql] of wanted) {
			if (present.has(name)) continue;
			differences.push(`缺少索引：${name}`);
			if (checkOnly) continue;
			// 唯一索引可能被既有的重复数据挡住。报清楚是哪一条，让人先去处理数据，
			// 而不是让整轮修复中断在这里。
			try { actual.exec(createIndexSql); }
			catch (error) { differences.push(`  ↑ 建索引失败（多半是已有重复数据）：${error instanceof Error ? error.message : error}`); }
		}
		for (const name of present.keys()) if (!wanted.has(name)) differences.push(`多余索引：${name}（不会自动删除）`);
	};
	for (const [table, createSql] of expectedTables) {
		if (!actualTables.has(table)) {
			differences.push(`缺少表：${table}`);
			if (!checkOnly) { actual.exec(createSql); repairIndexes(table); }
			continue;
		}
		const wanted = columns(expected, table), present = columns(actual, table);
		// migrations 是单文件全量 schema，标记应用过就不会再跑，后来加的列在旧库里
		// 因此永远不会出现。这里只报不补：新项目直接删库重建，不为此维护迁移路径。
		for (const column of wanted) if (!present.has(column)) differences.push(`缺少字段：${table}.${column}（删库重建即可）`);
		const extras = [...present].filter((column) => !wanted.has(column));
		for (const column of extras) differences.push(`多余字段：${table}.${column}`);
		if (extras.length && !checkOnly && dropExtra) rebuilds.push(() => rebuildTable(actual, expected, table, createSql, wanted, present));
		else repairIndexes(table);
	}
	for (const rebuild of rebuilds) rebuild();
	for (const table of actualTables.keys()) if (!expectedTables.has(table)) differences.push(`未管理表：${table}（不会自动删除）`);
	console.log(differences.length ? differences.join('\n') : '数据库结构与目标结构一致');
	if (!checkOnly) console.log(dropExtra ? `结构修复及多余字段清理完成：${databaseFile}` : `缺失结构修复完成；多余字段需使用 --drop-extra --yes 清理：${databaseFile}`);
} finally { expected.close(); actual.close(); await rm(temporary, { recursive: true, force: true }); }
