import type { Context, Next } from 'hono';
import type { AppEnv } from './types.mjs';
import { apiMessage } from './api-response.mjs';
import { handleTableCrudAction, tableCrudDatabase, type TableCrudDefinition } from './table-crud.mjs';
import { withDatabaseDeletedScope, withDatabasePendedScope } from '@server/database/index.mjs';
import { deletedScopeFromQuery } from './query-options.mjs';
import { operationScope } from './operation.mjs';

export type ApiNext = () => Promise<Response>;

export type ApiHandler = ((
	c: Context<AppEnv>,
	next: ApiNext,
	params: Record<string, string>,
) => Response | Promise<Response | undefined> | undefined) & { tableCrud?: TableCrudDefinition };

export type ApiModule = { default?: ApiHandler; tableCrud?: TableCrudDefinition };
export type SiteApiRoute = { site: string; path: string };

type RouteMatcher = {
	exact: Map<string, Set<string>>;
	byLength: Map<number, SiteApiRoute[]>;
};

const normalizeApiPath = (path: string, apiSuffix: string) => {
	if (!apiSuffix) return path;
	const segments = path.split('/');
	const suffixIndex = segments.findIndex((segment) => segment.endsWith(apiSuffix));
	if (suffixIndex < 0) return path;
	segments[suffixIndex] = segments[suffixIndex].slice(0, -apiSuffix.length);
	return segments.join('/');
};

const createRouteMatcher = (routes: SiteApiRoute[]): RouteMatcher => {
	const exact = new Map<string, Set<string>>();
	const byLength = new Map<number, SiteApiRoute[]>();
	for (const route of routes) {
		if (!route.path.includes('/:')) {
			const sites = exact.get(route.path) ?? new Set<string>();
			sites.add(route.site);
			exact.set(route.path, sites);
		}
		const length = route.path.split('/').filter(Boolean).length;
		const candidates = byLength.get(length) ?? [];
		candidates.push(route);
		byLength.set(length, candidates);
	}
	return { exact, byLength };
};

const matchRoute = (path: string, siteChain: string[], matcher: RouteMatcher) => {
	const exactSites = matcher.exact.get(path);
	if (exactSites) {
		const owner = siteChain.find((site) => exactSites.has(site));
		if (owner) return { owner, routePath: path, params: {} as Record<string, string> };
	}
	const requestSegments = path.split('/').filter(Boolean);
	for (const site of siteChain) {
		for (const route of matcher.byLength.get(requestSegments.length) ?? []) {
			if (route.site !== site || !route.path.includes('/:')) continue;
			const routeSegments = route.path.split('/').filter(Boolean);
			const params: Record<string, string> = {};
			let matches = true;
			for (let index = 0; index < routeSegments.length; index += 1) {
				if (routeSegments[index].startsWith(':')) {
					try { params[routeSegments[index].slice(1)] = decodeURIComponent(requestSegments[index]); }
					catch { matches = false; break; }
				} else if (routeSegments[index] !== requestSegments[index]) {
					matches = false;
					break;
				}
			}
			if (matches) return { owner: site, routePath: route.path, params };
		}
	}
	return undefined;
};

const modulePath = (site: string, routeSegments: string[], depth: number) => (
	depth === 0 ? `routes/${site}/api.mjs` : `routes/${site}/api/${routeSegments.slice(0, depth).join('/')}.mjs`
);

export const createApiGateway = (
	getApiSuffix: (context: Context<AppEnv>) => string,
	options: { routes: SiteApiRoute[]; loadModule: (file: string) => Promise<ApiModule> },
) => {
	const matcher = createRouteMatcher(options.routes);
	return async (c: Context<AppEnv>, _next: Next) => {
		const normalizedPath = normalizeApiPath(c.req.path, getApiSuffix(c));
		const siteChain = c.get('site').codeSiteChain;
		const matched = matchRoute(normalizedPath, siteChain, matcher);
		if (!matched) return apiMessage(c, 404);

		const routeSegments = matched.routePath.split('/').filter(Boolean).slice(1).filter((segment) => !segment.startsWith(':'));
		const files: string[] = [];
		for (let depth = 0; depth <= routeSegments.length; depth += 1) {
			for (const site of siteChain) {
				const file = modulePath(site, routeSegments, depth);
				const module = await options.loadModule(file);
				if (typeof module.default === 'function') {
					files.push(file);
					break;
				}
			}
		}
		const loadedModules = await Promise.all(files.map(async (file) => ({ file, module: await options.loadModule(file) })));
		const tableCrudEntry = [...loadedModules].reverse().find(({ module }) => module.tableCrud);
		if (tableCrudEntry) {
			c.set('tableCrud', tableCrudEntry.module.tableCrud!);
			const deletedScope = deletedScopeFromQuery(c);
			/**
			 * **要走审批的页面**才看得见待审批的新行。
			 *
			 * 不然它们在列表里根本不存在——提交的人以为没保存成功，审批的人也没地方点
			 * 「撤回申请」「立即批准」（那两个按钮由 withPendingApproval 按行挂上，
			 * 行都不出现就无从谈起）。
			 *
			 * 判定直接问 operationScope，不另写一遍路径比较：「这一页要不要走审批」和
			 * 「这一页看不看得见待审批的行」必须是同一个答案。各判各的迟早会漂移，那时候
			 * 就会出现「进了队列、却在任何列表里都找不到」的行。前台的自助操作立即生效，
			 * 本来就没有待审批的行，因此那边一个字都不用改。
			 */
			const pendedScope = operationScope(c) === 'admin' ? 'all' as const : 'active' as const;
			if (deletedScope !== 'active' || pendedScope !== 'active') {
				const key = tableCrudEntry.module.tableCrud!.database ?? 'database';
				let database = tableCrudDatabase(c, tableCrudEntry.module.tableCrud!);
				if (database) {
					if (deletedScope !== 'active') database = withDatabaseDeletedScope(database, deletedScope);
					if (pendedScope !== 'active') database = withDatabasePendedScope(database, pendedScope);
					c.set(key, database);
				}
			}
		}
		const tableCrudIndex = tableCrudEntry ? loadedModules.findIndex(({ file }) => file === tableCrudEntry.file) : -1;

		const execute = async (index: number): Promise<Response> => {
			const { module } = loadedModules[index];
			if (typeof module.default !== 'function') throw new Error(`API module must export a handler: ${loadedModules[index].file}`);
			// 共用动作（回收站的恢复/彻底删除、审批的撤回/立即批准）先于路由自己的分支处理。
			// 不再只在回收站范围里调用：撤回与立即批准发生在正常列表上，
			// 只在 deleted 范围里调的话它们永远走不到，表现是「API route did not return a response」。
			if (index === tableCrudIndex) {
				const sharedResponse = await handleTableCrudAction(c, tableCrudEntry!.module.tableCrud!, matched.params.id);
				if (sharedResponse) return sharedResponse;
			}
			const next = async () => index + 1 < files.length
				? execute(index + 1)
				: apiMessage(c, 500, 'API route did not return a response');
			return (await module.default(c, next, matched.params)) ?? apiMessage(c, 500, 'API route did not return a response');
		};
		return execute(0);
	};
};
