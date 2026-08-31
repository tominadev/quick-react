import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';

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
