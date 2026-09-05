import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { describeAuditChanges, parseAuditChanges, transitionAuditEntries } from './audit.mjs';
import { APPROVAL_SKIP_ROLES, readChangeReason } from './operation.mjs';

/** 标记列的字段名带下划线前缀，避免和业务列撞名。 */
export const PENDING_FIELD = '_pending';
export const WITHDRAW_ACTION = 'withdraw-pending';
export const APPROVE_ACTION = 'approve-pending';

type PendingEntry = { id: string; changes: string; reason: string; created_at: number };

/**
 * 这一行上还没落地的修改。
 *
 * 提交后进了审批队列，页面上却什么都看不出来——表单显示的仍是旧值，用户以为没保存成功，
 * 于是再改一次，队列里堆出第二条。把待审批的内容摆在页面上，这条路就断了。
 */
export const pendingEntriesFor = async (database: DatabaseAdapter, table: string, rowId: string | number | bigint) =>
	allSql<PendingEntry>(database, sql({ database }).select({
		table: 'base_audit_entries',
		columns: { id: { column: 'id', cast: 'text' }, changes: 'changes', reason: 'reason', created_at: 'created_at' },
		where: [{ column: 'table_name', value: table }, { column: 'row_id', value: String(rowId) }, { column: 'status', value: 'pending' }],
		orderBy: [{ column: 'id' }],
	}));

/**
 * 一次问清这一批行里哪些还有修改在等审批：逐行去查会把一次列表变成 N 次查询。
 *
 * 取的是这张表**全部**待审批行号再在内存里取交集，而不是按当前页的 id 过滤——
 * 待审批的行天然很少（它们在等人处理），为此给 SQL 层加一个 IN 运算符不划算。
 */
export const pendingRowIds = async (database: DatabaseAdapter, table: string, rowIds: readonly string[]) => {
	if (!rowIds.length) return new Set<string>();
	const rows = await allSql<{ row_id: string }>(database, sql({ database }).select({
		table: 'base_audit_entries', distinct: true,
		columns: { row_id: { column: 'row_id', cast: 'text' } },
		where: [{ column: 'table_name', value: table }, { column: 'status', value: 'pending' }],
	}));
	const pending = new Set(rows.map((row) => String(row.row_id)));
	return new Set(rowIds.filter((id) => pending.has(id)));
};

/** 配置项在 base_configs 里的行号；还没有这一行就没有待审批可言。 */
export const configRowId = async (c: Context<AppEnv>, key: string) => {
	const database = c.get('database');
	const tenantId = c.get('tenantId');
	const row = await firstSql<{ id: string }>(database, sql({ database }).select({
		table: 'base_configs', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'key', value: key }, tenantId === null ? { column: 'owner_tid', value: 1 } : { column: 'owner_tid', value: tenantId }],
		limit: 1,
	}));
	return row?.id;
};

const canApprove = (c: Context<AppEnv>) => (c.get('effectiveRoles') ?? []).some((role) => APPROVAL_SKIP_ROLES.includes(role));

/**
 * 待审批提示与可执行的动作。
 *
 * 「立即批准」与「立即生效」是同一件事的两个入口，因此走同一道角色门：能跳过审批的人
 * 才批得动。撤回不设门槛——撤回只是把自己提的申请收回去，数据一动不动。
 */
export const pendingApprovalNotice = async (c: Context<AppEnv>, table: string, rowId: string | number | bigint | undefined) => {
	if (rowId === undefined) return undefined;
	const entries = await pendingEntriesFor(c.get('database'), table, rowId);
	if (!entries.length) return undefined;
	const lines = entries.map((entry) => {
		const detail = describeAuditChanges(parseAuditChanges(entry.changes));
		return entry.reason ? `${detail}（原因：${entry.reason}）` : detail;
	});
	return {
		notice: `有 ${entries.length} 项修改正在等待审批，尚未生效：\n${lines.join('\n')}`,
		actions: [
			{ key: WITHDRAW_ACTION, label: '撤回申请', confirm: '确认撤回这些还没生效的修改吗？数据不会被改动。' },
			...(canApprove(c) ? [{ key: APPROVE_ACTION, label: '立即批准', confirm: '确认立即批准并生效吗？' }] : []),
		],
		ids: entries.map((entry) => entry.id),
	};
};

/** 处理提示里那两个动作；不是这两个就返回 undefined，交回给路由自己的分支。 */
export const handlePendingApprovalAction = async (c: Context<AppEnv>, table: string, rowId: string | number | bigint | undefined) => {
	const action = c.req.query('action');
	if (action !== WITHDRAW_ACTION && action !== APPROVE_ACTION) return undefined;
	if (rowId === undefined) return { ok: false as const, message: '没有待审批的修改' };
	if (action === APPROVE_ACTION && !canApprove(c)) return { ok: false as const, message: '没有批准权限' };
	const database = c.get('database');
	const entries = await pendingEntriesFor(database, table, rowId);
	if (!entries.length) return { ok: false as const, message: '没有待审批的修改' };
	const results = await transitionAuditEntries(database, entries.map((entry) => entry.id), action === APPROVE_ACTION ? 'applied' : 'rejected', readChangeReason(c));
	const failed = results.filter((result) => !result.ok);
	if (failed.length) return { ok: false as const, message: failed.map((result) => `#${result.id} ${result.message}`).join('；') };
	return { ok: true as const, message: action === APPROVE_ACTION ? `已批准并生效 ${results.length} 项修改` : `已撤回 ${results.length} 项申请` };
};
