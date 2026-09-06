import type { ApiHandler } from '@server/modules/base/api-router.mjs';

/**
 * SMS 管理面的目录级中间件。角色门在父级 `panel/admin.mts` 上，这里不重复判。
 *
 * 这一层下面的写入**都会进审批队列**：`operationScope` 只认 `/api/panel/admin/` 前缀。
 * 用户自己的手机与短信因此不在这里，而在 `/api/panel/user/sms/`——那边立即生效、
 * 照常留痕（见 navigation.mts 里那段划分）。
 */
const handler: ApiHandler = async (_c, next) => next();

export default handler;
