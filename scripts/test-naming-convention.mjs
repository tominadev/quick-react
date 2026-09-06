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
/** 没有 key 列的表，与 sql.mts 的 KEYLESS_TABLES 一一对应。 */
const keyless = new Set(['global_snowflake_state']);
/**
 * 每张表都带的十一个系统字段，顺序固定。
 *
 * 顺序一致是为了读：几十张表并排看时，前十列永远在同一个位置，眼睛不用重新找。
 * 它们还必须**连成一片**——被业务列隔开的话，「哪些是脚手架、哪些是这张表自己的东西」
 * 就得逐个辨认。
 */
const systemFields = ['id', 'key', 'created_at', 'updated_at', 'deleted_at', 'queued_at', 'created_duid', 'updated_duid', 'owner_tid', 'owner_bid', 'owner_uid'];
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
		// 每张表都要有 key：SQL 构造器在 INSERT 时统一补上，漏一张表就是运行时的
		// 「no such column: key」。例外只有发号器自己的状态表。
		if (!columns.includes('key') && !keyless.has(name)) problems.push(`${name} 没有 key 列`);
		// key 紧跟在 id 后面：两处对照着看时位置固定。
		if (columns.includes('key') && columns.indexOf('key') !== columns.indexOf('id') + 1) problems.push(`${name}.key 必须紧跟在 id 后面`);
		// 十个系统字段：一个不少、顺序一致、连成一片。
		const present = columns.filter((column) => systemFields.includes(column));
		const wanted = systemFields.filter((column) => columns.includes(column));
		if (present.join(',') !== wanted.join(',')) problems.push(`${name} 系统字段顺序不对：${present.join(' ')}`);
		const positions = columns.map((column, index) => systemFields.includes(column) ? index : -1).filter((index) => index >= 0);
		if (positions.length && positions[positions.length - 1] - positions[0] !== positions.length - 1) {
			problems.push(`${name} 系统字段被业务列隔断：${columns.slice(positions[0], positions[positions.length - 1] + 1).join(' ')}`);
		}
		const missing = systemFields.filter((column) => !columns.includes(column) && !(column === 'key' && keyless.has(name)));
		if (missing.length) problems.push(`${name} 缺少系统字段：${missing.join(' ')}`);
		// 长度封顶 36：雪花最长 19 位，人给的短串更短，客户端设备 UUID 正好 36。
		if (columns.includes('key') && !/\n\s+key\s+String\??\s+@db\.VarChar\(36\)/.test(body)) problems.push(`${name}.key 要声明 @db.VarChar(36)`);

		const uniqueIndexes = [...body.matchAll(/@@unique\(\[([^\]]+)\]\)/g)].map((match) => match[1].split(',').map((column) => column.trim()));
		/**
		 * **`key` 单独一个唯一索引，不与任何列组合。**
		 *
		 * 它本身就是唯一的（机器写的雪花号或 UUID），再拉一列进复合索引，那个索引永远不会
		 * 冲突——跟把 `id` 拉进去一样没有意义。租户内唯一那件事由 `name` 表达。
		 */
		if (columns.includes('key') && !uniqueIndexes.some((unique) => unique.length === 1 && unique[0] === 'key')) problems.push(`${name}.key 要有自己单独的唯一索引 @@unique([key])`);
		for (const unique of uniqueIndexes) {
			if (unique.includes('key') && unique.length > 1) problems.push(`${name} 把 key 塞进了复合索引：[${unique.join(', ')}]`);
		}
		/**
		 * **人给的值落在 `name` 上，唯一索引带 `owner_tid` 与 `deleted_at`。**
		 *
		 * `owner_tid`：名字在租户内唯一，不同租户可以各有一个 `main` 分站。
		 * `deleted_at`：名字是人取的，软删一行之后同一个名字该能再用。
		 *
		 * 两张顶层表例外，用 `[name, deleted_at]`：`base_tenants` 的租户名必须全库唯一
		 * （加 owner_tid 反而会允许两个同名租户），`passport_users` 在独立的账号中心库里，
		 * 登录名同样是全局的。
		 */
		const topLevel = new Set(['base_tenants', 'passport_users']);
		if (columns.includes('name')) {
			const wanted = topLevel.has(name) ? ['name', 'deleted_at'] : ['owner_tid', 'name', 'deleted_at'];
			if (!uniqueIndexes.some((unique) => unique.join(',') === wanted.join(','))) {
				problems.push(`${name}.name 要有 @@unique([${wanted.join(', ')}])，现有：${uniqueIndexes.map((unique) => `[${unique.join(', ')}]`).join(' ') || '（无）'}`);
			}
		}
		/**
		 * **只有 `name` 参与的唯一索引带 `deleted_at`。**
		 *
		 * 其余的要么是机器生成、永不重复的标识（key、各种 hash、token），要么是外部给定的
		 * 稳定标识，带上 `deleted_at` 纯属多余。`base_audits.settled_at` 是唯一的例外：
		 * 它是那条「一行同时只能有一条在队列里」的哨兵位，与软删无关。
		 */
		for (const unique of uniqueIndexes) {
			if (unique.includes('deleted_at') && !unique.includes('name')) problems.push(`${name} 的 [${unique.join(', ')}] 不该带 deleted_at——只有 name 需要`);
		}
	}
}

/**
 * **一行上同时只能有一条申请在队列里**，这是数据库约束，不是应用层「先查再写」的君子协定。
 *
 * `settled_at` 排队中记 0、了结时记时刻，于是同一行的第二条 pending 撞上前一条。
 * 先查再写挡不住两个请求同时进来，也认不出没有登录身份的模块级调用是谁。
 */
{
	const base = await readFile(resolve(projectDirectory, 'prisma/base.prisma'), 'utf8');
	const audits = /^model base_audits \{(.*?)^\}/ms.exec(base)?.[1] ?? '';
	if (!/@@unique\(\[table_name, row_key, settled_at\]\)/.test(audits)) problems.push('base_audits 缺少 @@unique([table_name, row_key, settled_at])');
	if (!/\n\s+settled_at\s+BigInt\s+@default\(0\)/.test(audits)) problems.push('base_audits.settled_at 要是 BigInt @default(0)');
}
assert.deepEqual(problems, [], `列命名不符合约定：\n  ${problems.join('\n  ')}`);
console.log('naming convention test passed');
