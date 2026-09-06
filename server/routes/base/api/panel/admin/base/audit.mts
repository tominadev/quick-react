import type { ApiHandler } from '@server/modules/base/api-router.mjs';

/**
 * 审计管理的目录级中间件。两页共用这一层：`records` 是每一次变更本身，
 * `approvals` 是这些变更被怎么处理的。角色门在父级 `panel/admin.mts` 上，这里不重复判。
 */
const handler: ApiHandler = async (_c, next) => next();

export default handler;
