import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 描述现状的文档和代码注释里，提到的表名和列名必须真的存在。
 *
 * 这个检查的由来：`docs/security.md` 一直写着「密码保存在 `base_users.password` 中」，而那一列
 * 早就拆去了 `base_user_credentials`——同一次拆分曾经让整个维护工具箱报 `no such column: password`
 * （见 maintenance-toolbox.md），代码修了，安全文档没跟着改。读文档的人会去 `base_users` 上找一个
 * 不存在的列，而这种错**看起来完全正常**，不跑一遍schema 对不出来。
 *
 * 只查**描述现状**的地方：AGENTS.md、架构/安全/接口文档、以及代码注释。
 * `docs/requirements/` 与 `docs/handoff/` 不查——它们描述的是目标状态，明确写着「未完成的条目
 * 不得视为已实现」，里面出现还没建的表是正常的，查了只会逼人把设计稿改成现状的复读。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
/** 只认这个项目自己的表：前缀是业务域，外部库的标识符（antd 的 `onClear`、SSH 的 `authorized_keys`）不在其列。 */
const TABLE_PREFIXES = ['base_', 'global_', 'passport_', 'sms_', 'pve_'];

const walk = async (directory, skip) => {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (skip.includes(entry.name)) continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await walk(full, skip));
		else found.push(full);
	}
	return found;
};

// ---- 真实的表与列 ----
const schema = new Map();
for (const file of (await readdir(resolve(projectDirectory, 'prisma'))).filter((name) => name.endsWith('.prisma'))) {
	const source = await readFile(resolve(projectDirectory, 'prisma', file), 'utf8');
	for (const model of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
		schema.set(model[1], new Set([...model[2].matchAll(/^\s{2}(\w+)\s+\S/gm)].map((match) => match[1])));
	}
}
/**
 * 迁移登记表由迁移器自己建，不进 prisma——它记录的是"哪些迁移跑过了"，而 prisma 管的是
 * 业务结构。名字是对的，只是不在 schema 里，所以按存在处理。
 */
schema.set('global_schema_migrations', new Set(['migration_key', 'applied_at']));

assert.ok(schema.size >= 20, `prisma 模型太少，扫描逻辑可能失效：${schema.size}`);
/**
 * 所有模型上出现过的列名。**跨表引用的列自带表前缀**（`passport_user_id`、`base_user_id`），
 * 光看名字与表名长得一模一样；不先把它们摘出来，满篇正确的列名都会被报成"不存在的表"。
 */
const everyColumn = new Set([...schema.values()].flatMap((columns) => [...columns]));

// ---- 要查的文件：描述现状的文档 + 全部代码注释 ----
const targets = ['AGENTS.md', 'README.md', 'docs/architecture.md', 'docs/security.md', 'docs/api.md', 'docs/configuration.md', 'docs/deployment.md', 'docs/development.md']
	.map((name) => resolve(projectDirectory, name));
for (const directory of ['server', 'clients', 'shared', 'scripts', 'docs/integration']) {
	const full = resolve(projectDirectory, directory);
	targets.push(...(await walk(full, ['node_modules', '.generated'])).filter((file) => /\.(mts|ts|tsx|mjs|cjs|md)$/.test(file)));
}

/**
 * 名字对不上 schema、但**写得没错**的地方，逐条写明理由。
 *
 * 分三类：讲这张表以前叫什么（沿革本来就该提旧名）、举例说明命名规则（那个名字按规则
 * 该长这样，只是眼下还没有表用到它）、以及假设句（"如果这一列叫 name 就读不出装的是什么"）。
 * 这三类删掉会让文字失去意思，所以是豁免，不是修改。
 */
const exempt = [
	{ file: 'server/routes/base/api/panel/admin/base/audit/approvals.mts', token: 'base_audit_transitions', reason: '讲沿革：这张表改名前就叫这个，旧名正是那段话要说的东西' },
	{ file: 'shared/system-fields.mts', token: 'sms_phones.name', reason: '假设句：用来说明"名字列读不出内容时可以换个词"，紧接着的段落讲的才是它的真实历史' },
	{ file: 'AGENTS.md', token: 'passport_device_id', reason: '举例命名规则：别的表引用 passport 设备时该这么起名，眼下还没有表这么引用' },
	{ file: 'docs/architecture.md', token: 'passport_device_id', reason: '同上，跨站点关联的概念名' },
	{ file: 'docs/architecture.md', token: 'passport_user_id', reason: '跨站点关联的概念名：服务端按它对应两侧身份，不是某张表的列' },
	{ file: 'docs/architecture.md', token: 'base_user_id', reason: '同上' },
	{ file: 'docs/development.md', token: 'passport_user_id', reason: '同上' },
	{ file: 'server/modules/sms/ticket.mts', token: 'base_user_id', reason: '同上' },
	{ file: 'scripts/test-sms-ticket-bind.mjs', token: 'base_user_id', reason: '同上' },
];
const exempted = (label, token) => exempt.some((item) => item.file === label && item.token === token);

const problems = [];
let checked = 0;
for (const file of targets) {
	let source;
	try { source = await readFile(file, 'utf8'); } catch { continue; }
	const label = file.replace(`${projectDirectory}/`, '');
	// 这个文件自己要举「曾经写错的那一处」当例子，不能被自己的规则判出错。
	if (label === 'scripts/test-doc-schema-refs.mjs') continue;
	for (const match of source.matchAll(/`([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?`/g)) {
		const [, table, column] = match;
		if (!TABLE_PREFIXES.some((prefix) => table.startsWith(prefix))) continue;
		// 是某张表上的列名（而不是表名）就跳过：那是在说一个字段，不是在说一张表。
		if (!column && everyColumn.has(table) && !schema.has(table)) continue;
		checked += 1;
		const line = source.slice(0, match.index).split('\n').length;
		const reference = column ? `${table}.${column}` : table;
		if (exempted(label, reference)) continue;
		const columns = schema.get(table);
		if (!columns) { problems.push(`${label}:${line}  提到的表 \`${table}\` 在 prisma 里不存在`); continue; }
		if (column && !columns.has(column)) problems.push(`${label}:${line}  \`${table}\` 上没有 \`${column}\` 这一列`);
	}
}

assert.ok(checked >= 50, `扫到的表名引用太少，扫描逻辑可能失效：${checked}`);
assert.deepEqual(problems, [], `以下地方提到了不存在的表或列，读的人会照着它去找：\n  ${problems.join('\n  ')}`);
console.log(`doc schema refs test passed（核对了 ${checked} 处表名与列名引用）`);
