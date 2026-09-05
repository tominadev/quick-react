/**
 * 每请求都要读的站点配置（系统配置、技术栈、站点设置）缓存 30 秒。
 *
 * 单独成一个模块而不是留在 worker 里：**写配置的路径不止一条**。正常保存走 configStore，
 * 它会顺手清缓存；而审批通过是直接把值写回 base_configs 的，绕过了那条路——不清缓存的话
 * 批准完页面还显示旧值，看起来像批准没生效。
 *
 * 这里只管「按（库，租户）存取和整库清空」，存什么由调用方定，因此不带类型参数。
 */
const cache = new WeakMap<object, { generation: number; bucket: Map<string, unknown> }>();
/**
 * 失效用代次号，不按对象身份去删。
 *
 * 数据库句柄常被 withDatabaseActors 包一层，包出来是**新对象**——按身份删的话
 * WeakMap 根本命中不到，缓存留在原地，批准完页面还显示旧值。代次号对不上就整桶作废，
 * 与调用方手上拿的是哪一层句柄无关。
 */
let generation = 0;

export const configurationBucket = (database: object) => {
	const existing = cache.get(database);
	if (existing && existing.generation === generation) return existing.bucket;
	const bucket = new Map<string, unknown>();
	cache.set(database, { generation, bucket });
	return bucket;
};

/** 配置变更本就罕见，整体作废只是让各租户各自重读一次。 */
export const invalidateConfigurationCache = () => { generation += 1; };

/** 配置存在哪张表——审批通过后据此判断要不要清缓存。 */
export const CONFIG_TABLE = 'base_configs';
