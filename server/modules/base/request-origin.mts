import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';

/**
 * 把接口地址上那层可配的后缀剥掉，还原成路由表里的逻辑路径。
 *
 * `.php` 是站点可配的技术栈伪装（`API_ROUTE_SUFFIX`，后台还能改成 `.json` 或留空），不是
 * 路径的一部分——同一个接口在不同站点长得不一样，而它们说的是同一件事。
 *
 * **按段找，不按结尾找。** 后缀贴在「接口入口」那一段上，后面还可以跟成员 id：
 * `/api/panel/admin/base/users.php/2`。用 `endsWith` 判的话这种地址一个字都剥不掉——
 * 审计里的 request_path 就是这么带上 `.php` 的，而集合地址却剥得干净，同一件事两种写法。
 *
 * 路由匹配与审计留痕共用这一个函数：两边各写一套的结果就是上面那个 bug。
 */
export const normalizeApiPath = (path: string, apiSuffix: string) => {
	if (!apiSuffix) return path;
	const segments = path.split('/');
	const suffixIndex = segments.findIndex((segment) => segment.endsWith(apiSuffix));
	if (suffixIndex < 0) return path;
	segments[suffixIndex] = segments[suffixIndex].slice(0, -apiSuffix.length);
	return segments.join('/');
};

const isLocalHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

export const requestOrigin = (c: Context<AppEnv>) => {
	const url = new URL(c.req.url);
	const host = url.host;
	const protocol = !isLocalHost(url.hostname) ? 'https' : url.protocol === 'https:' ? 'https' : 'http';
	return `${protocol}://${host}`;
};

export const isSecureRequest = (c: Context<AppEnv>) => requestOrigin(c).startsWith('https://');

/**
 * 从同源 Referer 取回发起操作的页面路径，供后端下发软导航目标。
 * API 请求没有页面路径，缺少或不可信 Referer 时统一回到首页。
 */
export const requestPagePath = (c: Context<AppEnv>, fallback = '/') => {
	try {
		const referer = c.req.header('referer');
		if (!referer) return fallback;
		const source = new URL(referer);
		if (source.origin !== requestOrigin(c) || source.pathname.startsWith('/api/')) return fallback;
		return `${source.pathname}${source.search}` || fallback;
	} catch {
		return fallback;
	}
};
