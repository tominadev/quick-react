import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectDirectory = resolve(import.meta.dirname, '..');

/**
 * 后台表格列的先后必须与 prisma 里对应模型的字段顺序一致。
 *
 * 只比**相对次序**：不是每个字段都显示，也允许有计算列和来自关联表的列，它们一律跳过。
 * 两处对照着看时不用来回找，加字段时也不必猜该插在哪。
 *
 * 表名在这里显式登记而不是从源码里猜：一个路由可能查好几张表（关联、选项、计数），
 * 猜出来的那张未必是列表主表，猜错了这个测试就成了摆设。
 */
const routeTables = {
	'base/api/panel/admin/base/approval-events.mts': 'base_approval_events',
	'base/api/panel/admin/base/audit.mts': 'base_approvals',
	'base/api/panel/admin/base/users.mts': 'base_users',
	'base/api/panel/agent/subordinates.mts': 'base_users',
	'global/api/panel/admin/global/cloud/credentials.mts': 'global_cloud_credentials',
	'global/api/panel/admin/global/cloud/email/bindings.mts': 'global_cloud_email_bindings',
	'global/api/panel/admin/global/cloud/email/channels.mts': 'global_cloud_email_channels',
	'global/api/panel/admin/global/cloud/email/templates.mts': 'global_cloud_email_templates',
	'global/api/panel/admin/global/cloud/object-storage/bindings.mts': 'global_cloud_object_storage_bindings',
	'global/api/panel/admin/global/cloud/object-storage/buckets.mts': 'global_cloud_object_storage_buckets',
	'global/api/panel/admin/global/site/hosts.mts': 'global_site_hosts',
	'global/api/panel/admin/global/site/sites.mts': 'global_sites',
	'global/api/panel/admin/global/telegram/bots.mts': 'global_telegram_bots',
	'passport/api/panel/accounts/devices.mts': 'passport_devices',
	'passport/api/panel/accounts/emails.mts': 'passport_emails',
	'passport/api/panel/admin/passport/devices.mts': 'passport_devices',
	'passport/api/panel/admin/passport/external-providers.mts': 'passport_external_providers',
	'passport/api/panel/admin/passport/oidc/clients.mts': 'passport_oidc_clients',
	'passport/api/panel/admin/passport/users.mts': 'passport_users',
};

/**
 * 不参与比对的表格，各有各的理由：
 * - 数据管理页的表和列都是运行时才知道的，没有固定模型可对照。
 * - 对象列表的数据来自云厂商接口，不是数据库。
 * - 第三方身份列表把几种来源合成一行，没有单一主表。
 */
const exempt = new Set([
	'base/api/panel/admin/base/data/columns.mts',
	'base/api/panel/admin/base/data/rows.mts',
	'global/api/panel/admin/global/cloud/object-storage/objects.mts',
	'passport/api/panel/accounts/identities.mts',
]);

const walk = async (directory) => {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await walk(full));
		else if (entry.name.endsWith('.mts')) found.push(full);
	}
	return found;
};

const schemaColumns = new Map();
for (const site of ['base', 'global', 'passport', 'pve']) {
	const source = await readFile(resolve(projectDirectory, 'prisma', `${site}.prisma`), 'utf8');
	for (const model of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
		schemaColumns.set(model[1], [...model[2].matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]));
	}
}

const routesDirectory = resolve(projectDirectory, 'server/routes');
const tableRoutes = [];
for (const file of (await walk(routesDirectory)).sort()) {
	const source = await readFile(file, 'utf8');
	if (source.includes('table: {')) tableRoutes.push([file.slice(routesDirectory.length + 1), source]);
}
assert.ok(tableRoutes.length >= 20, `表格路由太少，扫描逻辑可能失效：${tableRoutes.length}`);

const problems = [];
for (const [route, source] of tableRoutes) {
	if (exempt.has(route)) continue;
	const table = routeTables[route];
	if (!table) { problems.push(`${route}：未登记对应的数据表（新增表格路由要在 routeTables 里登记，或说明为什么豁免）`); continue; }
	const expected = schemaColumns.get(table);
	if (!expected) { problems.push(`${route}：prisma 里找不到模型 ${table}`); continue; }
	// 只看列定义数组里的 dataIndex，查询字段（带 label 的那些）不是表格列。
	const shown = [...source.matchAll(/\{\s*dataIndex:\s*'([a-z_]+)'(?![^}]*\blabel:)/g)].map((match) => match[1]);
	const listed = shown.filter((column) => expected.includes(column));
	const ordered = expected.filter((column) => listed.includes(column));
	if (JSON.stringify(listed) !== JSON.stringify(ordered)) {
		problems.push(`${route}（${table}）\n    现在：${listed.join(' ')}\n    应为：${ordered.join(' ')}`);
	}
}
assert.deepEqual(problems, [], `以下表格列的先后与 prisma 定义不一致：\n  ${problems.join('\n  ')}`);
// 设置类页面整表单提交，什么都没改也点了保存多半是误触；四个设置页要么都提示，
// 要么都不提示，漏掉一个只会让人以为这页坏了。
const settingsDirectory = resolve(projectDirectory, 'server/routes/base/api/panel/admin/base/settings');
for (const name of (await readdir(settingsDirectory)).filter((file) => file.endsWith('.mts'))) {
	const source = await readFile(join(settingsDirectory, name), 'utf8');
	assert.match(source, /confirmOnUnchangedSubmit/, `settings/${name} 缺少「当前未修改，仍要提交吗？」的提示`);
	// 设置页的改动往往立刻影响整个站点的行为，保存前要把改了什么列出来让人确认。
	assert.match(source, /confirmChangedSubmit/, `settings/${name} 缺少「保存前列出改动」的确认`);
	// 待审批提示、撤销申请、批准、驳回都由统一模板给出。自己写保存分支的页面会漏掉它们
	// ——站点设置接了、另外三页没接，就是这么来的。
	assert.match(source, /settingsPageHandler\(/, `settings/${name} 没有使用统一的设置页模板 settingsPageHandler`);
}

console.log(`column order test passed（${tableRoutes.length - exempt.size} 张表）`);
