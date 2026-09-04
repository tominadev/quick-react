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

/** 表的事实来源是 Prisma schema，加上由 migrate.mts 直接建的迁移记账表。 */
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

const { AUDITED_TABLES, UNAUDITED_TABLES, NON_AUDITED_COLUMNS, HIDDEN_VALUE_COLUMNS, isAuditedTable, isNonAuditedColumn, isHiddenValueColumn, hasAuditableColumns } = await loadConstants();
const schemaTables = await readSchemaTables();

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

// 排除列必须挡住心跳写入：只碰这些列的更新不读原行、不产生记录（§3.3）。
assert.equal(hasAuditableColumns(['expires_at', 'updated_at', 'updated_duid']), false);
assert.equal(hasAuditableColumns(['last_seen_at']), false);
assert.equal(hasAuditableColumns(['name', 'updated_at']), true);
assert.equal(hasAuditableColumns(['deleted_at']), true, '软删除与恢复必须留痕');
assert.equal(hasAuditableColumns([]), false);

assert.ok(isAuditedTable('base_users'));
assert.ok(!isAuditedTable('base_sessions'));
assert.ok(isNonAuditedColumn('last_seen_at') && !isNonAuditedColumn('name'));
// 凭证列照常记录、照常撤回，只是接口不返回值（§5）。
assert.ok(isHiddenValueColumn('password') && isHiddenValueColumn('value') && !isHiddenValueColumn('name'));
assert.ok(NON_AUDITED_COLUMNS.includes('updated_at') && HIDDEN_VALUE_COLUMNS.includes('access_key_secret'));

console.log(`audit tables ok: ${audited.size} audited, ${unaudited.size} unaudited, ${schemaTables.size} tables total`);
