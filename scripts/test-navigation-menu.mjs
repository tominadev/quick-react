import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'quick-react-navigation-menu-'));
try {
	const result = await build({ stdin: { contents: "export * from './shared/navigation-tree.mts';", resolveDir: resolve(import.meta.dirname, '..'), sourcefile: 'navigation-test-entry.mts' }, bundle: true, format: 'esm', platform: 'node', write: false });
	const file = join(directory, 'navigation.mjs');
	await writeFile(file, result.outputFiles[0].contents);
	const { collectPageDefinitions, findNavigationTrail, matchNavigationKey, navigationBreadcrumb, stripPageSuffix } = await import(pathToFileURL(file));

	const keys = ['/', '/panel/admin', '/about', '/panel/me', '/panel/accounts'];
	// 首页只匹配自身，不匹配其它路径。
	assert.equal(matchNavigationKey(keys, '/'), '/');
	assert.equal(matchNavigationKey(keys, '/about'), '/about');
	// 子路径高亮所属的顶层菜单，并且取最长匹配。
	assert.equal(matchNavigationKey(keys, '/panel/admin/base/users'), '/panel/admin');
	assert.equal(matchNavigationKey(keys, '/panel/accounts/profile'), '/panel/accounts');
	// 不属于任何菜单的页面不高亮。
	assert.equal(matchNavigationKey(keys, '/sign'), '');
	assert.equal(matchNavigationKey(keys, '/panel'), '');
	assert.equal(matchNavigationKey(keys, '/aboutus'), '');
	assert.equal(matchNavigationKey(keys, '/no-such-page'), '');
	// 前缀相同但不是同一段路径的不算匹配。
	assert.equal(matchNavigationKey(['/panel/admin'], '/panel/administrator'), '');
	assert.equal(matchNavigationKey([''], '/'), '');

	assert.equal(stripPageSuffix('/panel/accounts/profile.html', '.html'), '/panel/accounts/profile');
	assert.equal(stripPageSuffix('/', '.html'), '/');
	assert.equal(stripPageSuffix('/panel/admin', ''), '/panel/admin');
	const managementNavigation = [{ key: '/panel/admin', component: 'panelRoot', title: '管理后台', children: [
		{ key: '/panel/admin/base', label: '基础管理', children: [
			{ key: '/panel/admin/base/dashboard', component: 'dashboard', title: '基础仪表盘' },
		] },
		{ key: '/panel/admin/global', label: '全局管理', navigationGroup: 'global', children: [
			{ key: '/panel/admin/global/dashboard', component: 'dashboard', title: '全局仪表盘' },
		] },
	] }];
	const dashboard = collectPageDefinitions(managementNavigation).find((page) => page.path === '/panel/admin/global/dashboard');
	assert.deepEqual(dashboard?.navigation.map((item) => item.key), ['/panel/admin/base', '/panel/admin/global']);

	// ---- 面包屑 ----
	// 走整条菜单路径，而不是「页面标题 + 当前项」两截——后者在绝大多数页面上是同一个词，
	// 读出来是「站点设置 / 站点设置」，还是不告诉人这一页挂在哪个分组下。
	const panelNavigation = [{ key: '/panel/admin', label: '管理后台', children: [
		{ key: '/panel/admin/base', label: '基础管理', children: [
			{ key: '/panel/admin/base/settings', label: '系统设置', children: [
				{ key: '/panel/admin/base/settings/site', label: '站点设置' },
			] },
			{ key: '/panel/admin/base/data', label: '数据管理', children: [
				{ key: '/panel/admin/base/data/rows', label: '数据管理' },
			] },
		] },
	] }];
	assert.deepEqual(navigationBreadcrumb(panelNavigation, '/panel/admin/base/settings/site'), ['管理后台', '基础管理', '系统设置', '站点设置']);
	// 分组与页面同名时只留一个：写两遍不给读的人任何新信息。
	assert.deepEqual(navigationBreadcrumb(panelNavigation, '/panel/admin/base/data/rows'), ['管理后台', '基础管理', '数据管理']);
	// 菜单里没有的页面没有路径可走，调用方据此回落到页面标题。
	assert.deepEqual(navigationBreadcrumb(panelNavigation, '/panel/me'), []);
	// 同一条路径同时供菜单展开用：末项是当前页，前面几项就是要展开的父级。
	assert.deepEqual(
		findNavigationTrail(panelNavigation, '/panel/admin/base/settings/site').slice(0, -1).map((item) => item.key),
		['/panel/admin', '/panel/admin/base', '/panel/admin/base/settings'],
	);

	// 侧栏最顶层（基础管理、全局管理、Passport、PVE）不折叠，用分组标题加分隔线隔开：
	// 折叠起来的话，每次进来只有当前模块是展开的，想看看别的模块有什么得先点一下，
	// 而那一下点开还什么都不做（有子菜单的项只展开不跳转）。渲染要浏览器环境才测得到，
	// 这里守住生成菜单项的那段。
	const layoutSource = await readFile(resolve(import.meta.dirname, '../src/components/panel/PanelLayout.tsx'), 'utf8');
	assert.match(layoutSource, /if \(depth === 0 && children\?\.length\) \{/, '顶层要单独成组');
	assert.match(layoutSource, /type: 'group', key: item\.key, label: item\.label, children/, '顶层渲染成分组而不是可折叠子菜单');
	assert.match(layoutSource, /index > 0 \? \[\{ type: 'divider' \}/, '组与组之间要有分隔线');

	console.log('navigation menu test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
