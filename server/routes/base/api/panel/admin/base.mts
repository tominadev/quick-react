import type { ApiHandler } from '@server/modules/base/api-router.mjs';

// 基础后台能力的目录级中间件层。公共后台行为由父站点 base 提供，
// 具体设置、用户和数据接口继续沿当前路径进入下一级叶子处理器。
const handler: ApiHandler = async (_c, next) => next();

export default handler;
