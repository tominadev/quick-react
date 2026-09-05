import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiAuthContextFallback } from '@server/modules/base/api-response.mjs';

/**
 * 代理中心的门。
 *
 * 与管理后台那道门（`panel/admin.mts`）不同的是，进得来的人**不是运营这套系统的人**：
 * 代理是普通用户，只是名下挂着一批下级。因此它的接口一律走 self 作用域——照常留痕，
 * 但不进审批队列：没有谁是代理的审批人。
 */
const handler: ApiHandler = async (c, next) => {
	if (!c.get('effectiveRoles').includes('agent')) return apiAuthContextFallback(c, 403, '需要代理角色');
	return next();
};

export default handler;
