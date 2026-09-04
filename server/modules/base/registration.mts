import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseActorUid, DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSystemSql, sql } from '@server/database/sql.mjs';

/**
 * 本站当前允许哪种注册。
 *
 * - `bootstrap`：还没有初始管理员，允许创建一次，并且创建出来的是平台管理员。
 *   由 `base_bootstrap.initial_admin` 这把一次性闩控制，与开关无关——否则关掉开关
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
	const where = [{ column: 'key', value: 'initial_admin' }, ...(tenantId === null ? [] : [{ column: 'owner_tid', value: tenantId }])];
	const row = await firstSql<{ value: string }>(database, sql({ database }).select({ table: 'base_bootstrap', columns: { value: 'value' }, where }));
	if (row?.value === 'open') return 'bootstrap';
	return c.get('siteSettings').registrationEnabled ? 'open' : 'closed';
};

/**
 * 新建账号后的收尾：把行归属给账号自己，并在昵称为空时默认用用户名。
 *
 * 昵称租户内唯一，而用户名也唯一，所以「昵称 = 用户名」在创建那一刻不会撞自己。
 * 但它可能撞上**别人挑走的昵称**——张三把昵称设成 `bob`，之后真正的 `bob` 来注册，
 * 默认昵称就占不到了。这时候**放弃默认值，不让注册失败**：默认昵称是便利，
 * 不是必需品，为它挡住一次合法注册是本末倒置。
 *
 * 因此分两条语句：先建号，再单独试着写昵称，撞了就算了。没有事务可用，
 * 而这里也不需要——失败的那一半只是「昵称没设上」，不影响账号本身。
 */
export const finishUserCreation = async (database: DatabaseAdapter, username: string, tenantId: DatabaseActorUid, nickname?: string) => {
	const scope = tenantId === null ? { column: 'owner_tid', operator: 'IS NULL' as const } : { column: 'owner_tid', value: tenantId };
	const created = await firstSql<{ id: number | string | bigint }>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: username }, scope], limit: 1 }));
	if (!created) return undefined;
	// 账号行归属账号自己，不归创建它的人。
	await runSystemSql(database, sql({ database }).update('base_users', { owner_uid: created.id }, { id: created.id }));
	const desired = (nickname ?? '').trim() || username;
    try { await runSystemSql(database, sql({ database }).update('base_users', { nickname: desired }, { id: created.id })); }
	catch { /* 昵称被占用：留空，不影响注册本身 */ }
	return created.id;
};
