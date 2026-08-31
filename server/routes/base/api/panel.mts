import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiAuthContextFallback } from '@server/modules/base/api-response.mjs';

const handler: ApiHandler = async (c, next) => {
	const roles = c.get('effectiveRoles');
	if (!roles.includes('user') && !roles.includes('accounts')) return apiAuthContextFallback(c, 401, '请先登录');
	return next();
};

export default handler;
