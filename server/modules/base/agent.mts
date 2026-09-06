import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperationSql } from './operation.mjs';
import { parseRoles } from '@shared/types/role.mjs';

/**
 * 代理看名下下级：**接口层授权，不放宽行级判定**。
 *
 * 代理是普通用户，行级判定给它的谓词是 `owner_uid = 自己`，因此它本来一行下级都读不到。
 * 这里改用系统上下文（跳过判定）再显式追加 `agent_uid = 自己`——把这件事做成谓词里的
 * 一个分支才是真正危险的：那等于让「代理」这个角色在全库范围内生效，而这里能碰到的
 * 只有 base_users 的这几列（需求文档 §3.1）。
 *
 * 下级的**业务数据**不在这里，那要走代查，一次一个账号并留痕（§3.2）。
 */
const AGENT_LIST_COLUMNS = {
	id: { column: 'u.id', cast: 'text' as const },
	user_name: 'u.name',
	profile_nickname: 'p.nickname',
	status: 'u.status',
	created_at: 'u.created_at',
};

/** 系统上下文的构造器：只关掉行级判定，归属与操作者仍取自本次请求，留痕因此记在代理名下。 */
const agentBuilder = (database: DatabaseAdapter) => sql({ database, subjectRoles: null });

export const listSubordinates = async (database: DatabaseAdapter, agentId: string) => allSql<Record<string, unknown>>(database, agentBuilder(database).select({
	table: 'base_users',
	alias: 'u',
	columns: AGENT_LIST_COLUMNS,
	joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }],
	where: [{ column: 'u.agent_uid', value: agentId }],
	orderBy: [{ column: 'u.id', direction: 'DESC' }],
}));

type ClaimTarget = { id: string; name: string; roles: string | null; agent_uid: string | null; owner_bid: string | null };

/**
 * 拉号：按用户名把一个**还没有代理**的账号收到自己名下。
 *
 * 只认 `NULL → 自己` 这一个方向。**已经有代理的账号一律拒绝**——那是转移归属，会改变
 * 计费归集（历史账单按产生时钉死的 `owner_aid` 算，之后的新账单跟着新代理走），
 * 只能由 `tenant_admin` 或 `platform_admin` 执行（§5、§7）。这条判定同时写在 WHERE 里，
 * 所以两个代理同时拉同一个人时只有一个能成：另一个的 UPDATE 匹配不到行。
 *
 * 目标有任何角色都拒绝，不单是管理员：管理员成为谁的下级本身是提权路径（代理随后就能
 * 对它代查），而带 `agent` 角色的账号被拉走就成了二级代理——本期固定两层（§10）。
 */
export const claimSubordinate = async (c: Context<AppEnv>, database: DatabaseAdapter, userName: string) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) return { error: '请先登录' };
	const agentId = String(currentUser.id);
	const name = userName.trim();
	if (!name) return { error: '请输入要拉取的用户名' };
	const builder = agentBuilder(database);
	// 按名查找限本租户：用户名只在租户内唯一，跨租户查会拿到别人的同名账号。
	// 默认的 active 范围同时挡住了两类行——回收站里的，以及**还在审批队列里的新账号**
	// （queued_at 非 0）：那个账号还没被批准存在，先被人拉走就成了既成事实。
	const target = await firstSql<ClaimTarget>(database, builder.select({
		table: 'base_users',
		columns: { id: { column: 'id', cast: 'text' }, name: 'name', roles: 'roles', agent_uid: { column: 'agent_uid', cast: 'text' }, owner_bid: { column: 'owner_bid', cast: 'text' } },
		where: [{ column: 'name', value: name }, ownerScope('owner_tid', c.get('tenantId'))],
		limit: 1,
	}));
	if (!target) return { error: `本站没有用户「${name}」` };
	if (String(target.id) === agentId) return { error: '不能把自己拉成自己的下级' };
	if (target.agent_uid !== null && target.agent_uid !== undefined && String(target.agent_uid) !== '') {
		return { error: `用户「${name}」已经有代理了，转移归属请联系管理员` };
	}
	if (parseRoles(target.roles).length) return { error: `用户「${name}」是管理员或代理，不能作为下级` };
	// 代理关系不跨分站：分站管理的正是所属的用户与代理（§4.1）。
	const branchId = c.get('branchId');
	if (branchId !== null && String(target.owner_bid ?? '') !== String(branchId)) {
		return { error: `用户「${name}」不在本分站，不能拉取` };
	}
	// 条件更新：`agent_uid IS NULL` 一起进 WHERE，并发下只有一个代理能拉到。
	await runOperationSql(c, database, builder.update('base_users', { agent_uid: agentId }, [
		{ column: 'id', value: target.id },
		{ column: 'agent_uid', operator: 'IS NULL' },
	]));
	// 回读确认，不看驱动各说各话的影响行数：四种方言的 meta 形状并不一致。
	const claimed = await firstSql<{ agent_uid: string | null }>(database, builder.select({
		table: 'base_users', columns: { agent_uid: { column: 'agent_uid', cast: 'text' } }, where: [{ column: 'id', value: target.id }], limit: 1,
	}));
	if (String(claimed?.agent_uid ?? '') !== agentId) return { error: `用户「${name}」刚刚已被其他代理拉走` };
	return { user: { id: target.id, user_name: target.name } };
};
