import type { NavigationItem } from './types/navigation.mjs';

export type NavigationPageDefinition = {
	path: string;
	component: string;
	title: string;
	description: string;
	navigation: NavigationItem[];
	dashboardPath?: string;
	mode?: string;
	apiPath?: string;
	submitMethod?: 'POST' | 'PUT';
	redirectPath?: string;
};

export const stripPageSuffix = (path: string, pageSuffix: string) => (
	pageSuffix && path.endsWith(pageSuffix) ? path.slice(0, -pageSuffix.length) : path
);

/** 页面逻辑路径统一不带尾斜杠，根路径除外。 */
export const stripTrailingSlash = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') : path;

/** 目录页面使用 index 作为物理入口，但导航仍以目录逻辑路径注册。 */
export const normalizePagePath = (path: string, pageSuffix = '') => {
	const withoutSuffix = stripPageSuffix(path, pageSuffix);
	const withoutTrailingSlash = stripTrailingSlash(withoutSuffix);
	if (withoutTrailingSlash === '/index') return '/';
	return withoutTrailingSlash.endsWith('/index')
		? withoutTrailingSlash.slice(0, -'/index'.length) || '/'
		: withoutTrailingSlash;
};

/**
 * 从菜单树里找出到这一页的**整条路径**：`[顶层, …, 当前页]`，找不到返回空数组。
 *
 * 菜单高亮要的是最后一项、展开要的是前面几项的 key、面包屑要的是整条——它们找的本来
 * 就是同一条路径，各走一遍树是白费。
 */
export const findNavigationTrail = (menu: NavigationItem[], pathname: string, parents: NavigationItem[] = []): NavigationItem[] => {
	for (const item of menu) {
		const trail = [...parents, item];
		if (item.key === pathname) return trail;
		const found = item.children ? findNavigationTrail(item.children, pathname, trail) : [];
		if (found.length) return found;
	}
	return [];
};

/**
 * 面包屑要显示的那几个名字。
 *
 * **连着重名的只留一个**：`数据管理 / 数据管理` 的上一层是分组、下一层是页面，两个词
 * 一模一样，写两遍不给读的人任何新信息。真要区分得去改导航里的名字，那是另一回事。
 */
export const navigationBreadcrumb = (menu: NavigationItem[], pathname: string) => findNavigationTrail(menu, pathname)
	.map((item) => item.label)
	.filter((label, index, labels) => label !== labels[index - 1]);

/**
 * 顶层菜单高亮：取与当前路径匹配的最长 key，`/` 只匹配自身；
 * 没有任何菜单匹配时返回空串，调用方据此清空高亮。
 */
export const matchNavigationKey = (keys: string[], logicalPath: string) => keys
	.filter((key) => key && (key === '/' ? logicalPath === '/' : `${logicalPath}/`.startsWith(`${key}/`)))
	.sort((left, right) => right.length - left.length)[0] ?? '';

const resolveNodeKey = (key: string, parentPath: string) => {
	if (key === '/') return '/';
	if (key.startsWith('/')) return key;
	return `/${[parentPath.replace(/^\//, '').replace(/\/$/, ''), key].filter(Boolean).join('/')}`;
};

export const resolveNavigationPaths = (items: NavigationItem[], parentPath = ''): NavigationItem[] => items.map((item) => {
	const key = String(item.key ?? '');
	const path = resolveNodeKey(key, parentPath);
	return { ...item, key: path, children: item.children ? resolveNavigationPaths(item.children, path) : undefined };
});

export const mergeNavigation = (base: NavigationItem[], overrides: NavigationItem[], parentPath = ''): NavigationItem[] => {
	const remaining = new Map(overrides.map((item) => {
		const key = resolveNodeKey(String(item.key), parentPath);
		return [key, { ...item, key }];
	}));
	const merged = base.map((item) => {
		const key = resolveNodeKey(String(item.key), parentPath);
		const override = remaining.get(key);
		if (!override) return { ...item, key, children: item.children ? mergeNavigation(item.children, [], key) : undefined };
		remaining.delete(key);
		return {
			...item,
			...override,
			key,
			children: mergeNavigation(item.children ?? [], override.children ?? [], key),
		};
	});
	return [...merged, ...remaining.values()].map((item) => ({
		...item,
		children: item.children ? mergeNavigation(item.children, [], String(item.key)) : undefined,
	}));
};

export const filterNavigationByRoles = (items: NavigationItem[], roles: Set<string>): NavigationItem[] => items.flatMap((item) => {
	const requiredRoles = Array.isArray(item.roles) ? item.roles.filter((role): role is string => typeof role === 'string') : ['public'];
	if (!requiredRoles.some((role) => roles.has(role))) return [];
	return [{ ...item, children: item.children ? filterNavigationByRoles(item.children, roles) : undefined }];
});

/** 按 key 精确查找导航节点，用于读取页面所需角色等元信息。 */
export const findNavigationItem = (items: NavigationItem[], key: string): NavigationItem | undefined => {
	for (const item of items) {
		if (String(item.key) === key) return item;
		const child = item.children ? findNavigationItem(item.children, key) : undefined;
		if (child) return child;
	}
	return undefined;
};

/** 菜单组可以把任意层级下的第一个 Dashboard 作为默认入口。 */
const findDashboardPath = (items: NavigationItem[] = []): string | undefined => {
	for (const item of items) {
		if (item.component === 'dashboard') return String(item.key);
		const nested = findDashboardPath(item.children);
		if (nested) return nested;
	}
	return undefined;
};

/** 为导航组补齐默认 Dashboard 路径，供通用菜单直接导航。 */
export const resolveDashboardPaths = (items: NavigationItem[]): NavigationItem[] => items.map((item) => {
	const children = item.children ? resolveDashboardPaths(item.children) : undefined;
	const dashboardPath = item.dashboardPath ?? findDashboardPath(children);
	return {
		...item,
		...(children ? { children } : {}),
		...(dashboardPath ? { dashboardPath } : {}),
	};
});

export const collectPageDefinitions = (
	items: NavigationItem[],
	navigation: NavigationItem[] = items,
	dashboardPath?: string,
): NavigationPageDefinition[] => items.flatMap((item) => {
	// 后台页面共享管理根节点的 children（基础管理、业务站点管理等），
	// 这样侧栏既能切换模块，也能展开当前模块自己的子菜单。
	const pageNavigation = item.component === 'panel' || item.component === 'panelRoot' ? item.children ?? [] : navigation;
	const pageDashboardPath = item.dashboardPath
		?? (item.component === 'panel' || item.component === 'panelRoot' ? findDashboardPath(item.children) : dashboardPath);
	const pages = typeof item.component === 'string' && typeof item.title === 'string'
		? [{ path: String(item.key), component: item.component, title: item.title, description: String(item.description ?? ''), navigation: pageNavigation, dashboardPath: pageDashboardPath }]
		: [];
	const children = item.children ? collectPageDefinitions(item.children, pageNavigation, pageDashboardPath) : [];
	return [...pages, ...children];
});

export const uniquePageDefinitions = (items: NavigationItem[]) => [...new Map(
	collectPageDefinitions(items).map((page) => [page.path, page]),
).values()];
