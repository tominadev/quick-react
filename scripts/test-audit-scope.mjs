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

const { HIDDEN_VALUE_COLUMNS, isHiddenValueColumn, isHiddenValueKey, ...constants } = await loadConstants();

// 受管范围里**一个表级例外都没有**：人和机器的分界线不在表名上，由 runOperation 显式声明。
// 审计表自己也不例外——递归由 runSystemSql 挡住（审计模块自身的写入不留痕），
// 因此改一条审计记录会照常留痕，留下的那条新记录就是「谁动了审计」的证据。
assert.deepEqual(Object.keys(constants).filter((name) => /TABLES$/.test(name)), [], '不该再有按表划分的清单');

// 凭证列照常记录、照常回滚，只是接口不返回值（§5）。整列隐藏的列绝不逐键展开。
assert.ok(isHiddenValueColumn('password') && !isHiddenValueColumn('name'));
// base_configs.value 不再整列隐藏：JSON 按键求差异之后能逐键区分，密钥那几个键单独藏，
// 其余（页脚、联系邮箱这些）照常可见——原先整列藏掉，站点配置改了什么完全看不见。
assert.ok(!isHiddenValueColumn('value'));
// JSON 里的键名列不全，除了同名列的名单还要按名字兜底；驼峰先折成下划线。
assert.ok(isHiddenValueKey('clientSecret') && isHiddenValueKey('client_secret') && isHiddenValueKey('apiToken'));
assert.ok(isHiddenValueKey('password') && isHiddenValueKey('privateKey'));
assert.ok(!isHiddenValueKey('footer') && !isHiddenValueKey('contactEmail') && !isHiddenValueKey('issuer'));
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

// insert 也算受管写入：新增一行同样要留痕（待审批的新增在列表上就是 _pending=insert-mine）。
// 漏掉它的话，一条裸的 insert 可以在后台路由里悄悄建行而不留任何记录。
const managedWrite = /\brunSql\([^;]*?\.(insert|update|upsert|softDelete|restore)\(/s;
const offenders = [];
for (const file of panelFiles) {
	const contents = await readFile(file, 'utf8');
	for (const [index, line] of contents.split('\n').entries()) {
		if (managedWrite.test(line)) offenders.push(`${file.slice(projectDirectory.length + 1)}:${index + 1}`);
	}
}
assert.deepEqual(offenders, [], `后台路由里的受管写入必须走 runOperation（或显式的 runSystemSql）：\n  ${offenders.join('\n  ')}`);

console.log(`audit scope ok: ${panelFiles.length} 个 panel 路由文件无裸受管写入`);
