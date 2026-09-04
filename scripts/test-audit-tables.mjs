import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const projectDirectory = resolve(import.meta.dirname, '..');

const loadConstants = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'quick-react-audit-tables-'));
	try {
		const result = await build({ entryPoints: [join(projectDirectory, 'shared/audit-tables.mts')], bundle: true, format: 'esm', platform: 'node', write: false });
		const file = join(directory, 'audit-tables.mjs');
		await writeFile(file, result.outputFiles[0].contents);
		return await import(pathToFileURL(file));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

/** 公共层自己维护的列：不是业务字段，不需要在白名单里出现。 */
const MANAGED_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'created_duid', 'updated_duid', 'owner_tid', 'owner_bid']);

/** 表与列的事实来源都是 Prisma schema，加上由 migrate.mts 直接建的迁移记账表。 */
const readSchemaTables = async () => {
	const prismaDirectory = join(projectDirectory, 'prisma');
	const files = (await readdir(prismaDirectory)).filter((file) => file.endsWith('.prisma'));
	assert.ok(files.length, 'prisma 目录下没有 schema 文件');
	const tables = new Set(['global_schema_migrations']);
	for (const file of files) {
		const contents = await readFile(join(prismaDirectory, file), 'utf8');
		for (const match of contents.matchAll(/^model\s+([a-z0-9_]+)\s*\{/gm)) tables.add(match[1]);
	}
	return tables;
};

/** 每张表的业务列：去掉公共层维护的那几个，剩下的都要在白名单里做一次显式决定。 */
const readSchemaColumns = async () => {
	const prismaDirectory = join(projectDirectory, 'prisma');
	const files = (await readdir(prismaDirectory)).filter((file) => file.endsWith('.prisma'));
	const columns = new Map();
	for (const file of files) {
		let model = null;
		for (const line of (await readFile(join(prismaDirectory, file), 'utf8')).split('\n')) {
			const text = line.trim();
			if (text.startsWith('model ')) { model = text.split(/\s+/)[1]; columns.set(model, []); continue; }
			if (text === '}') { model = null; continue; }
			if (!model || !text || text.startsWith('//') || text.startsWith('@@')) continue;
			const name = text.split(/\s+/)[0];
			if (/^[a-z][a-z0-9_]*$/.test(name) && !MANAGED_COLUMNS.has(name)) columns.get(model).push(name);
		}
	}
	return columns;
};

const { AUDITED_TABLES, UNAUDITED_TABLES, AUDITED_COLUMNS, HIDDEN_VALUE_COLUMNS, isAuditedTable, isAuditedColumn, isHiddenValueColumn, auditableColumns } = await loadConstants();
const schemaTables = await readSchemaTables();
const schemaColumns = await readSchemaColumns();

// §3.4：新增表时忘记登记，那张表就静默地没有审计。漏比吵严重，因此遗漏必须是构建失败。
const audited = new Set(AUDITED_TABLES), unaudited = new Set(UNAUDITED_TABLES);
assert.equal(audited.size, AUDITED_TABLES.length, 'AUDITED_TABLES 有重复项');
assert.equal(unaudited.size, UNAUDITED_TABLES.length, 'UNAUDITED_TABLES 有重复项');

const both = [...audited].filter((table) => unaudited.has(table));
assert.deepEqual(both, [], `同时出现在两份清单里的表：${both.join(', ')}`);

const unlisted = [...schemaTables].filter((table) => !audited.has(table) && !unaudited.has(table)).sort();
assert.deepEqual(unlisted, [], `新增的表必须登记进 AUDITED_TABLES 或 UNAUDITED_TABLES：${unlisted.join(', ')}`);

const unknown = [...audited, ...unaudited].filter((table) => !schemaTables.has(table)).sort();
assert.deepEqual(unknown, [], `清单里的表在 schema 中不存在，可能已改名或删除：${unknown.join(', ')}`);

// 审计表自身不被审计，否则记录一条变更会再产生一条变更。
assert.ok(unaudited.has('base_audit_entries'), 'base_audit_entries 必须在 UNAUDITED_TABLES 中');
assert.ok(!audited.has('base_audit_entries'));

// 列白名单必须逐表覆盖：新增业务列时不做决定就失败，与表那一层同样的道理。
const columnTables = Object.keys(AUDITED_COLUMNS).sort();
assert.deepEqual(columnTables.filter((table) => !audited.has(table)), [], 'AUDITED_COLUMNS 里出现了不受管的表');
assert.deepEqual([...audited].filter((table) => !AUDITED_COLUMNS[table]).sort(), [], '受管表必须在 AUDITED_COLUMNS 里声明它审计哪些列');
for (const table of columnTables) {
	const known = schemaColumns.get(table) ?? [];
	const unknown = AUDITED_COLUMNS[table].filter((column) => !known.includes(column));
	assert.deepEqual(unknown, [], `${table} 的白名单里有 schema 中不存在的列：${unknown.join(', ')}`);
	assert.equal(new Set(AUDITED_COLUMNS[table]).size, AUDITED_COLUMNS[table].length, `${table} 的白名单有重复项`);
}

// 白名单之外的列一律不算变更，包括心跳、上游快照、探活结果与派生字段。
assert.deepEqual(auditableColumns('base_users', ['name', 'status']), ['name', 'status']);
assert.deepEqual(auditableColumns('base_oidc_users', ['profile']), [], 'profile 是上游快照');
assert.deepEqual(auditableColumns('global_sites', ['migration_status']), [], 'migration_status 是迁移状态机');
assert.deepEqual(auditableColumns('global_sites', ['dsn', 'migration_status']), ['dsn'], '混在业务列里时只留下业务列');
assert.deepEqual(auditableColumns('pve_nodes', ['last_checked_at', 'last_error']), [], '探活结果不算变更');
assert.deepEqual(auditableColumns('base_sessions', ['token_hash']), [], '未受管的表没有可审计的列');
assert.deepEqual(auditableColumns('base_users', []), []);
// deleted_at 是公共层维护的，但软删除与恢复必须留痕，因此单独放行。
assert.deepEqual(auditableColumns('base_users', ['deleted_at']), ['deleted_at'], '软删除与恢复必须留痕');

assert.ok(isAuditedTable('base_users'));
assert.ok(!isAuditedTable('base_sessions'));
assert.ok(isAuditedColumn('base_users', 'name') && !isAuditedColumn('base_users', 'last_seen_at'));
// 凭证列照常记录、照常撤回，只是接口不返回值（§5）。
assert.ok(isHiddenValueColumn('password') && isHiddenValueColumn('value') && !isHiddenValueColumn('name'));
assert.ok(HIDDEN_VALUE_COLUMNS.includes('access_key_secret'));

console.log(`audit tables ok: ${audited.size} audited, ${unaudited.size} unaudited, ${schemaTables.size} tables total`);
