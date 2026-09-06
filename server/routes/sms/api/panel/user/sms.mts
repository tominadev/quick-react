import type { ApiHandler } from '@server/modules/base/api-router.mjs';

/**
 * SMS 用户面的目录级中间件。登录门在父级 `panel/user.mts` 上，这里不重复判。
 *
 * 这一层下面的写入**立即生效**：`operationScope` 只认 `/api/panel/admin/` 前缀，
 * 其余一律是自助——照常留痕，但不进队列。手机绑定必须落在这边，走审批的话那一行会
 * 带着非 0 的 `queued_at`，对正常查询不可见，而 Shortcut 发来的短信正要靠查这一行
 * 认领归属：手机还在排队时短信会被拒收。
 */
const handler: ApiHandler = async (_c, next) => next();

export default handler;
