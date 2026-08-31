import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiResponse } from '@server/modules/base/api-response.mjs';
import { buildAuthState, resolvePageStatus } from '@server/modules/base/page-context.mjs';
import { getSiteNavigation } from '@server/modules/base/navigation.mjs';

/**
 * 返回当前站点的完整认证、导航和页面状态，供 API 启动及软导航后的应用更新页面。
 * 认证方式、按钮和权限仍由后端生成，前端不根据站点或接口路径推断。
 */
const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	c.header('Cache-Control', 'no-store');
	const auth = await buildAuthState(c);
	const pathValue = c.req.query('path');
	let pageStatus;
	if (pathValue) {
		try {
			const path = new URL(pathValue, 'http://localhost').pathname.slice(0, 256);
			pageStatus = await resolvePageStatus(c, path, auth);
		} catch {
			pageStatus = undefined;
		}
	}
	return apiResponse(c, 200, {
		auth,
		siteNavigation: getSiteNavigation(c.get('site').codeSiteChain, c.get('effectiveRoles')),
		...(pageStatus ? { pageStatus } : {}),
	});
};

export default handler;
