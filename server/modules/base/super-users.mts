import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, sql } from '@server/database/sql.mjs';

/**
 * 超级用户：**唯一可以自己批自己申请的人**。
 *
 * 在这之前，审批不是关卡而只是一条自愿的复核通道——进得来后台的三个角色都能批，
 * 于是提交人自己点一下批准就过了（需求文档 §14 把这一点列为已知限制）。加上这道判定之后：
 *
 * - 名单里的人：照旧，自己提的自己就能批。单人运维的站点靠它继续干活。
 * - 其余有审批权的人：**只能批别人提的**，自己提的要另一个人来看一眼——四眼原则。
 *
 * 名单放在 `.env` 而不是数据库：数据库被拿下的人不该能把自己写进这份名单。这与救援
 * 工具箱同构——高危能力一律要求带外授权。
 *
 * **未设置时默认 `1`**，也就是每个站点的初始管理员：不给默认值的话，新装的站点没有
 * 任何人是超级用户，主人提交的第一个修改就没人能批，系统当场卡死。
 * 显式设成空串则表示**没有超级用户**，任何人都要双人复核——那是主人主动做的选择。
 */
const DEFAULT_SUPER_USER_IDS = '1';

export const parseSuperUserIds = (value: string | number | undefined) => new Set(
	(value === undefined ? DEFAULT_SUPER_USER_IDS : String(value))
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean),
);

export const isSuperUser = (c: Context<AppEnv>) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) return false;
	return parseSuperUserIds(c.env.SUPER_USER_IDS as string | number | undefined).has(String(currentUser.id));
};

/**
 * 这些审批记录分别是谁提交的（返回 `记录 id → 提交人的用户 id`）。
 *
 * 记录里存的是 `created_duid`——**设备**用户，不是人。直接拿它和当前请求的 duid 比，
 * 同一个人换台设备就成了「两个人」，四眼原则当场失效。因此要多查一层落到 user_id。
 */
export const submitterIdsOf = async (database: DatabaseAdapter, deviceUserIds: readonly string[]) => {
	const unique = [...new Set(deviceUserIds.filter(Boolean))];
	if (!unique.length) return new Map<string, string>();
	const rows = await allSql<{ id: string; user_id: string }>(database, sql({ database }).select({
		table: 'base_device_users',
		columns: { id: { column: 'id', cast: 'text' }, user_id: { column: 'user_id', cast: 'text' } },
		deleted: 'all',
	}));
	return new Map(rows.filter((row) => unique.includes(String(row.id))).map((row) => [String(row.id), String(row.user_id)]));
};

/**
 * 挡住「自己批自己」。返回 undefined 表示放行，否则是给人看的理由。
 *
 * 撤销自己的申请不受这道判定管——那是把自己提的东西收回去，不是放行。
 */
export const assertNotSelfApproval = async (
	c: Context<AppEnv>,
	database: DatabaseAdapter,
	entries: ReadonlyArray<{ id: string; created_duid: string | null }>,
) => {
	if (isSuperUser(c)) return undefined;
	const currentUser = c.get('currentUser');
	if (!currentUser) return '请先登录';
	const submitters = await submitterIdsOf(database, entries.map((entry) => String(entry.created_duid ?? '')));
	const mine = entries.filter((entry) => submitters.get(String(entry.created_duid ?? '')) === String(currentUser.id));
	if (!mine.length) return undefined;
	return `不能审批自己提交的申请（${mine.length} 条），请由另一个有审批权的人处理`;
};
