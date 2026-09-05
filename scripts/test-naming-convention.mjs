import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 列命名约定（docs/requirements/column-naming.md）。
 *
 * 规矩只有写进测试才立得住：`code` 与 `key`、`name` 与 `display_name` 就是这么各写各的，
 * 直到 `pve_regions` 同时长出 `code`、`name`、`display_name` 三个才被发现。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const prismaDirectory = join(projectDirectory, 'prisma');
const banned = { code: 'key', display_name: 'title', label: 'title', caption: 'title' };
const problems = [];

for (const file of (await readdir(prismaDirectory)).filter((name) => name.endsWith('.prisma')).sort()) {
	const source = await readFile(join(prismaDirectory, file), 'utf8');
	for (const model of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
		const [, name, body] = model;
		const columns = [...body.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]);
		const uniques = [...body.matchAll(/@@unique\(\[([^\]]*)\]/g)].flatMap((match) => match[1].split(',').map((value) => value.trim()));
		for (const column of columns) {
			if (banned[column]) problems.push(`${name}.${column}：改用 ${banned[column]}`);
			// 显示名不能当外键目标：出现 <x>_title 说明有人拿它去关联了。
			if (column.endsWith('_title')) problems.push(`${name}.${column}：显示名不能被引用，外键要指向 id 或 key`);
		}
		// 能被别的表引用的标识必须唯一，否则引用指向哪一行都说不准。
		if (columns.includes('key') && !uniques.includes('key')) problems.push(`${name}.key 没有唯一约束`);
	}
}
assert.deepEqual(problems, [], `列命名不符合约定：\n  ${problems.join('\n  ')}`);
console.log('naming convention test passed');
