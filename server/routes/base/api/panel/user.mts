import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiAuthContextFallback } from '@server/modules/base/api-response.mjs';

/**
 * 用户面的门。
 *
 * 与管理后台那道门（`panel/admin.mts`）对称，但要求不同：那边查管理员角色，这边**只要登录**。
 * `/panel/user/` 下装的是用户处置自己的东西，凭的是「这是我的行」而不是「我有什么角色」——
 * 越界靠行级归属判定在 SQL 层挡住，不靠菜单权限。
 *
 * 菜单上写的 `roles: ['user']` 与这道门说的是同一件事：每个登录用户都带着 `user` 角色，
 * 未登录的只有 `public`。用户面到此为止，不再往下分等级；个别子面另有要求的（代理中心要
 * `agent`）在它自己那一层收窄。
 *
 * 路径前缀同时决定**要不要走审批**：`operationScope` 只认 `/api/panel/admin/`，其余一律是
 * 用户自助——立即生效、照常留痕、不进队列（见 change-audit-and-revert.md §11.2）。
 */
const handler: ApiHandler = async (c, next) => {
	if (!c.get('currentUser')) return apiAuthContextFallback(c, 401, '请先登录');
	return next();
};

export default handler;
