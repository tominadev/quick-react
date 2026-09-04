import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiAuthContextFallback } from '@server/modules/base/api-response.mjs';

const handler: ApiHandler = async (c, next) => {
	// 平台管理员与租户管理员都可进入后台；各子页面再按自身角色门收窄。
	const roles = c.get('effectiveRoles');
	if (!roles.some((role) => ['platform_admin', 'tenant_admin', 'branch_admin'].includes(role))) return apiAuthContextFallback(c, 403, '需要管理员角色');
	return next();
};

export default handler;
