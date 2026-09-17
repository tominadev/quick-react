import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseActorUid, DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSystemSql, sql, ownerScope } from '@server/database/sql.mjs';

/**
 * 本站当前允许哪种注册。
 *
 * - `bootstrap`：还没有初始管理员，允许创建一次，并且创建出来的是平台管理员。
 *   由 `base_bootstraps` 里 `name = 'initial_admin'` 那一行充当一次性闩，与开关无关——否则关掉开关
 *   就再也没人能进后台了。
 * - `open`：站点设置里开了「允许用户注册」，任何人都能注册**普通用户**。
 * - `closed`：都不满足，注册入口整个不出现。
 *
 * 两处判定（注册接口与页面入口）必须用同一个函数：分开写迟早会漂移成
 * 「页面上有注册入口，点进去被拒绝」或者反过来。
 */
export type RegistrationMode = 'bootstrap' | 'open' | 'closed';

export const resolveRegistrationMode = async (c: Context<AppEnv>): Promise<RegistrationMode> => {
	// 引导状态要在未登录时也读得到，因此走系统上下文；租户由主机名解析而来。
	const database = c.get('systemDatabase');
	const tenantId = c.get('tenantId');
	const where = [{ column: 'name', value: 'initial_admin' }, ...(tenantId === null ? [] : [{ column: 'owner_tid', value: tenantId }])];
	const row = await firstSql<{ value: string }>(database, sql({ database }).select({ table: 'base_bootstraps', columns: { value: 'value' }, where }));
	if (row?.value === 'open') return 'bootstrap';
	return c.get('siteSettings').registrationEnabled ? 'open' : 'closed';
};

/**
 * 新建账号后的收尾：把行归属给账号自己。
 *
 * 昵称不在这里写——它拆到 base_user_profiles 之后是「没有行就回落到用户名」，
 * 不需要在建号时抄一份进去。抄过去反而会撞上别人挑走的昵称。
 */
export const finishUserCreation = async (database: DatabaseAdapter, userName: string, tenantId: DatabaseActorUid) => {
	// deleted: 'all' 才读得到刚建的行：走审批的新建带着 queued_at，普通查询看不到它，
	// 而收尾（把归属指回账号自己）恰恰要在批准之前做完。
	const scope = ownerScope('owner_tid', tenantId);
	const created = await firstSql<{ id: number | string | bigint }>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, deleted: 'all', where: [{ column: 'name', value: userName }, scope], limit: 1 }));
	if (!created) return undefined;
	// 账号行归属账号自己，不归创建它的人。
	await runSystemSql(database, sql({ database }).update('base_users', { owner_uid: created.id }, { id: created.id }));
	return created.id;
};
