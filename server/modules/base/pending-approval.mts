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
export const REJECT_ACTION = 'reject-pending';

type PendingEntry = { id: string; changes: string; reason: string; created_at: number; created_duid: string | null };

/** 当前请求的操作者（device_user_id）；系统或无设备操作为 null。 */
const actorOf = (database: DatabaseAdapter) => database.actorUidForTable?.('base_approvals') ?? database.actorUid ?? null;
const sameActor = (entry: PendingEntry, actor: string | number | bigint | null) =>
	actor !== null && entry.created_duid !== null && String(entry.created_duid) === String(actor);

/**
 * 这一行上还没落地的修改。
 *
 * 提交后进了审批队列，页面上却什么都看不出来——表单显示的仍是旧值，用户以为没保存成功，
 * 于是再改一次，队列里堆出第二条。把待审批的内容摆在页面上，这条路就断了。
 */
export const pendingEntriesFor = async (database: DatabaseAdapter, table: string, rowId: string | number | bigint) =>
	allSql<PendingEntry>(database, sql({ database }).select({
		table: 'base_approvals',
		columns: { id: { column: 'id', cast: 'text' }, changes: 'changes', reason: 'reason', created_at: 'created_at', created_duid: { column: 'created_duid', cast: 'text' } },
		where: [{ column: 'table_name', value: table }, { column: 'row_id', value: String(rowId) }, { column: 'review_status', value: 'pending' }],
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
		table: 'base_approvals', distinct: true,
		columns: { row_id: { column: 'row_id', cast: 'text' } },
		where: [{ column: 'table_name', value: table }, { column: 'review_status', value: 'pending' }],
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
 * 待审批提示块与可执行的动作。
 *
 * 三个按钮各有各的出现条件：
 * - **撤回申请**只在「这条是我自己提的」时出现——撤回的意思是把自己的申请收回去，
 *   替别人撤等于替别人做决定，那是驳回该干的事。
 * - **批准 / 驳回**只对有审批权的人出现。批准与「立即生效」是同一件事的两个入口，
 *   共用同一道角色门。
 *
 * 驳回和撤回落到同一个状态，但不是同一件事：一个是审批人否掉别人的申请，
 * 一个是申请人收回自己的，因此权限和按钮都分开。
 */
export const pendingApprovalNotice = async (c: Context<AppEnv>, table: string, rowId: string | number | bigint | undefined) => {
	if (rowId === undefined) return undefined;
	const database = c.get('database');
	const entries = await pendingEntriesFor(database, table, rowId);
	if (!entries.length) return undefined;
	const actor = actorOf(database);
	const mine = entries.filter((entry) => sameActor(entry, actor));
	const approver = canApprove(c);
	return {
		type: 'warning' as const,
		title: `有 ${entries.length} 项修改正在等待审批，尚未生效`,
		lines: entries.map((entry) => {
			const detail = describeAuditChanges(parseAuditChanges(entry.changes));
			const who = sameActor(entry, actor) ? '（本人提交）' : '';
			return entry.reason ? `${detail}${who}（原因：${entry.reason}）` : `${detail}${who}`;
		}),
		actions: [
			...(mine.length ? [{ key: WITHDRAW_ACTION, label: mine.length === entries.length ? '撤销申请' : `撤销我的 ${mine.length} 项申请`, confirm: '确认撤销这些还没生效的申请吗？数据不会被改动。' }] : []),
			...(approver ? [
				{ key: APPROVE_ACTION, label: '批准并生效', confirm: '确认批准并立即生效吗？' },
				{ key: REJECT_ACTION, label: '驳回', confirm: '确认驳回这些修改吗？数据不会被改动。', danger: true },
			] : []),
		],
	};
};

/** 处理提示里那两个动作；不是这两个就返回 undefined，交回给路由自己的分支。 */
export const handlePendingApprovalAction = async (c: Context<AppEnv>, table: string, rowId: string | number | bigint | undefined) => {
	const action = c.req.query('action');
	if (action !== WITHDRAW_ACTION && action !== APPROVE_ACTION && action !== REJECT_ACTION) return undefined;
	if (rowId === undefined) return { ok: false as const, message: '没有待审批的修改' };
	// 权限在服务端再判一次：按钮不出现只是不引诱人去点，挡住伪造请求靠这一句。
	if (action !== WITHDRAW_ACTION && !canApprove(c)) return { ok: false as const, message: '没有审批权限' };
	const database = c.get('database');
	const all = await pendingEntriesFor(database, table, rowId);
	// 撤销只动自己提的那几条：替别人撤等于替别人做决定，那是驳回该干的事。
	const entries = action === WITHDRAW_ACTION ? all.filter((entry) => sameActor(entry, actorOf(database))) : all;
	if (!entries.length) return { ok: false as const, message: action === WITHDRAW_ACTION ? '没有你自己提交的待审批申请' : '没有待审批的修改' };
	const target = action === APPROVE_ACTION ? 'approve' as const : action === REJECT_ACTION ? 'reject' as const : 'withdraw' as const;
	const results = await transitionAuditEntries(database, entries.map((entry) => entry.id), target, readChangeReason(c));
	const failed = results.filter((result) => !result.ok);
	if (failed.length) return { ok: false as const, message: failed.map((result) => `#${result.id} ${result.message}`).join('；') };
	const label = action === APPROVE_ACTION ? '已批准并生效' : action === REJECT_ACTION ? '已驳回' : '已撤销';
	return { ok: true as const, message: `${label} ${results.length} 项修改` };
};
