import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';

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

const { SELF_EXCLUDED_TABLES, HIDDEN_VALUE_COLUMNS, isSelfExcludedTable, isHiddenValueColumn } = await loadConstants();

// 审计表自身不被审计，否则记录一条变更会再产生一条变更。这是唯一的表级例外。
assert.deepEqual([...SELF_EXCLUDED_TABLES], ['base_audit_entries']);
assert.ok(isSelfExcludedTable('base_audit_entries'));
assert.ok(!isSelfExcludedTable('base_users'), '除审计表外没有第二个表级例外——人和机器的分界线不在表名上');

// 凭证列照常记录、照常撤回，只是接口不返回值（§5）。
assert.ok(isHiddenValueColumn('password') && isHiddenValueColumn('value') && !isHiddenValueColumn('name'));
assert.ok(HIDDEN_VALUE_COLUMNS.includes('access_key_secret'));
assert.equal(new Set(HIDDEN_VALUE_COLUMNS).size, HIDDEN_VALUE_COLUMNS.length, 'HIDDEN_VALUE_COLUMNS 有重复项');

/**
 * 覆盖面不能靠"记得调用 runOperation"（§6.1）。runSql 里有一道运行时断言，
 * 这里再加一道静态检查：后台与账户中心的路由里不允许出现裸的受管写入。
 */
const panelFiles = [];
const walk = async (directory) => {
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, item.name);
		if (item.isDirectory()) await walk(full);
		else if (item.name.endsWith('.mts') && full.includes(`api${'/'}panel`)) panelFiles.push(full);
	}
};
await walk(join(projectDirectory, 'server/routes'));
assert.ok(panelFiles.length > 10, `没有扫到 panel 路由文件（扫到 ${panelFiles.length} 个）`);

const managedWrite = /\brunSql\([^;]*?\.(update|upsert|softDelete|restore)\(/s;
const offenders = [];
for (const file of panelFiles) {
	const contents = await readFile(file, 'utf8');
	for (const [index, line] of contents.split('\n').entries()) {
		if (managedWrite.test(line)) offenders.push(`${file.slice(projectDirectory.length + 1)}:${index + 1}`);
	}
}
assert.deepEqual(offenders, [], `后台路由里的受管写入必须走 runOperation（或显式的 runSystemSql）：\n  ${offenders.join('\n  ')}`);

console.log(`audit scope ok: ${panelFiles.length} 个 panel 路由文件无裸受管写入`);
