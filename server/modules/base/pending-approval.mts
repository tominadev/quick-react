import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { describeAuditChanges, parseAuditChanges, transitionAuditEntries } from './audit.mjs';
import { APPROVAL_SKIP_ROLES, readChangeReason } from './operation.mjs';
import { assertNotSelfApproval, isSuperUser, submitterIdsOf } from './super-users.mjs';

export { PENDING_FIELD } from '@shared/types/table.mjs';
export const WITHDRAW_ACTION = 'withdraw-pending';
export const APPROVE_ACTION = 'approve-pending';
export const REJECT_ACTION = 'reject-pending';

type PendingEntry = { id: string; changes: string; reason: string; created_at: number; created_duid: string | null };

/**
 * 这几条申请里哪些是**当前这个人**提的。
 *
 * 比到人，不比到设备：记录里存的是 created_duid（设备用户），直接拿它和当前请求的 duid 比，
 * 同一个人换台设备就成了「两个人」——他会看到「批准」而不是「撤回」，点下去又被四眼原则
 * 挡回来。四眼原则那一侧（assertNotSelfApproval）早就落到人了，这一侧要用同一把尺子。
 */
const mineOf = async (c: Context<AppEnv>, database: DatabaseAdapter, entries: readonly PendingEntry[]) => {
	const me = String(c.get('currentUser')?.id ?? '');
	if (!me || !entries.length) return new Set<string>();
	const submitters = await submitterIdsOf(database, entries.map((entry) => String(entry.created_duid ?? '')));
	return new Set(entries.filter((entry) => submitters.get(String(entry.created_duid ?? '')) === me).map((entry) => String(entry.id)));
};

/**
 * 这一行上还没落地的修改。
 *
 * 提交后进了审批队列，页面上却什么都看不出来——表单显示的仍是旧值，用户以为没保存成功，
 * 于是再改一次，队列里堆出第二条。把待审批的内容摆在页面上，这条路就断了。
 */
export const pendingEntriesFor = async (database: DatabaseAdapter, table: string, rowId: string | number | bigint) =>
	allSql<PendingEntry>(database, sql({ database }).select({
		table: 'base_approvals',
		// 回收站视图会把适配器的默认范围设成 deleted，那说的是**被浏览的那张表**。
		// 不写死 active 的话，这里会去找「已删除的审批记录」，一条都找不到——
		// 于是在回收站里恢复一条记录、进了队列，行上却不显示待审批，撤回和批准两个按钮
		// 被 visibleWhen 一起藏掉。
		deleted: 'active',
		columns: { id: { column: 'id', cast: 'text' }, changes: 'changes', reason: 'reason', created_at: 'created_at', created_duid: { column: 'created_duid', cast: 'text' } },
		where: [{ column: 'table_name', value: table }, { column: 'row_id', value: String(rowId) }, { column: 'review_status', value: 'pending' }],
		orderBy: [{ column: 'id' }],
	}));

/**
 * 这一行等着审批的是**哪一种**申请、是不是**我自己**提的。
 *
 * 两件事决定了行上该出现哪几个按钮：撤回只对自己提的有意义（替别人撤等于替别人做决定，
 * 那是驳回该干的事），驳回只对别人提的有意义（自己的东西直接撤回就是了）。而新增与修改
 * 要分开说：「撤回新增」会把那一行删掉，「撤回修改」一个字都不动数据，同一句话概括不了。
 *
 * 一次问清整批行：逐行去查会把一次列表变成 N 次查询。取的是这张表**全部**待审批记录
 * 再在内存里取交集，而不是按当前页的 id 过滤——待审批的行天然很少（它们在等人处理），
 * 为此给 SQL 层加一个 IN 运算符不划算。
 */
export type PendingRowKind = 'insert' | 'update' | 'soft_delete' | 'restore';
export type PendingRowState = { kind: PendingRowKind; mine: boolean };
const KNOWN_KINDS: readonly string[] = ['insert', 'update', 'soft_delete', 'restore'];

export const pendingRowStates = async (c: Context<AppEnv>, database: DatabaseAdapter, table: string, rowIds: readonly string[]) => {
	const states = new Map<string, PendingRowState>();
	if (!rowIds.length) return states;
	const rows = await allSql<PendingEntry & { row_id: string; action: string }>(database, sql({ database }).select({
		table: 'base_approvals',
		// 审批记录自己有没有被删，与正在浏览的那张表是不是回收站视图无关。
		deleted: 'active',
		columns: { id: { column: 'id', cast: 'text' }, row_id: { column: 'row_id', cast: 'text' }, action: 'action', created_duid: { column: 'created_duid', cast: 'text' }, changes: 'changes', reason: 'reason', created_at: 'created_at' },
		where: [{ column: 'table_name', value: table }, { column: 'review_status', value: 'pending' }],
		orderBy: [{ column: 'id' }],
	}));
	const wanted = new Set(rowIds);
	const relevant = rows.filter((row) => wanted.has(String(row.row_id)));
	if (!relevant.length) return states;
	const mine = await mineOf(c, database, relevant);
	for (const row of relevant) {
		const id = String(row.row_id);
		const previous = states.get(id);
		const kind = KNOWN_KINDS.includes(row.action) ? row.action as PendingRowKind : 'update';
		states.set(id, {
			// 新增压过其余：一行同时挂着新建与随后的改草稿时，「这一行还不存在」是更要紧的事。
			// 其余按记录顺序取最后一条——那是这一行上最新的一次申请。
			kind: previous?.kind === 'insert' ? 'insert' : kind,
			// 只要有一条不是自己提的，整行就不算「我的申请」——撤回只撤得动自己那几条，
			// 按钮显示成撤回却只撤走一半，比不显示更糟。
			mine: (previous?.mine ?? true) && mine.has(String(row.id)),
		});
	}
	return states;
};

/**
 * **存在性申请**：新增、删除、恢复决定的是「这一行在不在」；修改决定的是「它是什么样」。
 *
 * 存在性还没定下来之前不接受内容申请——一行同时挂着「要不要有它」和「把它改成什么样」，
 * 审批人得在脑子里合并两条记录才知道批准之后是什么样，而批一条驳一条的组合里有好几种
 * 根本没人想要（驳回新增再批准修改，那条修改作用在一行已经进了回收站的记录上）。
 */
export const EXISTENCE_KINDS: readonly PendingRowKind[] = ['insert', 'soft_delete', 'restore'];

/**
 * 内容动作（编辑、删除）在这些取值上才出现。
 *
 * `visibleWhen` 是白名单，因此这里列的是**允许**的取值：没有待审批，或者挂着的是一条
 * 内容申请。挂着存在性申请时，编辑与删除按钮一并收起来。
 */
export const CONTENT_ACTION_VALUES = ['', 'update-mine', 'update-other'];

/** 行上那一列的取值：`insert-mine`、`soft_delete-other` 之类；没有待审批就是空串。 */
export const pendingRowToken = (state: PendingRowState | undefined) => state ? `${state.kind}-${state.mine ? 'mine' : 'other'}` : '';

/**
 * 四种申请各自的说法。
 *
 * 一句「撤回申请」概括不了它们:撤回新增会把那一行删掉,撤回修改一个字都不动数据,
 * 撤回删除是让记录留在原处,撤回恢复是让它留在回收站里——后果各不相同,而这正是
 * 点下去之前要知道的事。
 */
export const PENDING_KINDS: ReadonlyArray<{ kind: PendingRowKind; label: string; approve: string; reject: string; withdraw: string }> = [
	// 一行上可能同时挂着好几条申请（新建之后又改过草稿，建号那三行还共享一个操作号），
	// 点一次就是把这一行上的它们**一起**处理掉，因此措辞说的是「这一行上的申请」而不是
	// 「这一条」——按钮上只写得下最要紧的那一种（新增压过其余），别让它听起来只动一条。
	{ kind: 'insert', label: '新增', approve: '确认批准这一行上的申请吗？这一行会开始生效。', reject: '确认驳回这一行上的申请吗？这一行是新建的，驳回后会进回收站。', withdraw: '确认撤回这一行上还没生效的申请吗？这一行是新建的，撤回后会进回收站。' },
	{ kind: 'update', label: '修改', approve: '确认批准这一行上的修改并立即生效吗？', reject: '确认驳回这一行上的修改吗？数据不会被改动。', withdraw: '确认撤回这一行上还没生效的修改吗？数据不会被改动。' },
	{ kind: 'soft_delete', label: '删除', approve: '确认批准并把这条记录移入回收站吗？', reject: '确认驳回这条删除吗？记录会留在原处。', withdraw: '确认撤回这条还没生效的删除吗？记录会留在原处。' },
	{ kind: 'restore', label: '恢复', approve: '确认批准并把这条记录放回列表吗？', reject: '确认驳回这条恢复吗？记录会留在回收站里。', withdraw: '确认撤回这条还没生效的恢复吗？记录会留在回收站里。' },
];

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
/** 只有超级用户能批自己提的（§13.5 四眼原则）。 */
const canApproveOwn = (c: Context<AppEnv>) => canApprove(c) && isSuperUser(c);

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
	const mineIds = await mineOf(c, database, entries);
	const mine = entries.filter((entry) => mineIds.has(String(entry.id)));
	const others = entries.filter((entry) => !mineIds.has(String(entry.id)));
	const approver = canApprove(c), superUser = canApproveOwn(c);
	return {
		type: 'warning' as const,
		title: `有 ${entries.length} 项修改正在等待审批，尚未生效`,
		lines: entries.map((entry) => {
			const detail = describeAuditChanges(parseAuditChanges(entry.changes));
			const who = mineIds.has(String(entry.id)) ? '（本人提交）' : '';
			return entry.reason ? `${detail}${who}（原因：${entry.reason}）` : `${detail}${who}`;
		}),
		/**
		 * **撤销与驳回互斥**：自己提的叫撤销，别人提的叫驳回，同一批申请不会同时出现两个。
		 *
		 * 原先这两个按钮的条件是「我提过」和「我有审批权」——而提交人往往自己就有审批权，
		 * 于是三个按钮一起摆出来，让人分不清该点哪个。它们本来就作用在不同的申请上：
		 * 撤销只动自己那几条，驳回只动别人那几条。
		 *
		 * 一行上两个人各提过一次时（谁的申请都不覆盖谁的），两个按钮才会同时出现——那时
		 * 标题里写清各自管几条，说的仍然不是同一批东西。
		 *
		 * 批准自己那一份只给超级用户：其余人受四眼原则限制，点了必然失败（§13.5）。
		 */
		actions: [
			...(mine.length ? [{ key: WITHDRAW_ACTION, label: mine.length === entries.length ? '撤销申请' : `撤销我的 ${mine.length} 项申请`, confirm: '确认撤销这些还没生效的申请吗？数据不会被改动。' }] : []),
			...(approver && (superUser || !mine.length) ? [{ key: APPROVE_ACTION, label: '批准并生效', confirm: '确认批准并立即生效吗？' }] : []),
			...(approver && others.length ? [{ key: REJECT_ACTION, label: others.length === entries.length ? '驳回' : `驳回其他人的 ${others.length} 项申请`, confirm: '确认驳回这些修改吗？数据不会被改动。', danger: true }] : []),
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
	// 批准和驳回都是替这条申请做决定，因此都挡住「自己批自己」；撤销不挡——那是把自己
	// 提的东西收回去。
	if (action !== WITHDRAW_ACTION) {
		const selfApproval = await assertNotSelfApproval(c, database, all);
		if (selfApproval) return { ok: false as const, message: selfApproval };
	}
	/**
	 * 撤销只动自己提的，驳回只动别人提的——**两个动作作用在不相交的两批申请上**。
	 *
	 * 撤销是把自己提的东西收回去，替别人撤等于替别人做决定；驳回是审批人否掉别人的申请，
	 * 自己的东西直接撤回就是了。分开之后，一行上两个人各提过一次时，两个按钮各管各的那几条，
	 * 不会互相踩；驳回也不再会撞上四眼原则那道判定而整批失败。
	 */
	const mineIds = action === APPROVE_ACTION ? undefined : await mineOf(c, database, all);
	const entries = !mineIds ? all
		: action === WITHDRAW_ACTION ? all.filter((entry) => mineIds.has(String(entry.id)))
			: all.filter((entry) => !mineIds.has(String(entry.id)));
	if (!entries.length) return { ok: false as const, message: action === WITHDRAW_ACTION ? '没有你自己提交的待审批申请' : action === REJECT_ACTION ? '没有别人提交的待审批申请，自己的申请请用撤销' : '没有待审批的修改' };
	const target = action === APPROVE_ACTION ? 'approve' as const : action === REJECT_ACTION ? 'reject' as const : 'withdraw' as const;
	const results = await transitionAuditEntries(database, entries.map((entry) => entry.id), target, readChangeReason(c));
	const failed = results.filter((result) => !result.ok);
	if (failed.length) return { ok: false as const, message: failed.map((result) => `#${result.id} ${result.message}`).join('；') };
	const label = action === APPROVE_ACTION ? '已批准并生效' : action === REJECT_ACTION ? '已驳回' : '已撤销';
	return { ok: true as const, message: `${label} ${results.length} 项修改` };
};
