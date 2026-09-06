import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { readChangeReason } from '@server/modules/base/operation.mjs';
import { allSql, AUDIT_TABLE, sql, type SqlCondition } from '@server/database/sql.mjs';
import { DATA_LABELS, REVIEW_LABELS, auditTransitionsFor, countAuditEntries, describeAuditChanges, kindLabel, listAuditEntries, parseAuditChanges, publicAuditChanges, readAuditEntry, transitionAuditEntries, type AuditTransitionRow, type AuditEntryRow } from '@server/modules/base/audit.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { assertNotSelfApproval, isSuperUser, submitterIdsOf } from '@server/modules/base/super-users.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 四种动作各给一个颜色,按 diff 的老规矩来:新增绿、删除红、修改蓝、恢复青。
 *
 * 原先这一列下发的是中文文本,因此只能是一串黑字——而这一页十几行滚下来,「这条是删除」
 * 是最先要认出来的事。改成和审批状态、数据状态一样的 options:值发原文,文案和颜色由
 * 选项给。顺带补上 `insert`——原先的映射表里没有它,新建那些行显示的是英文 `insert`。
 */
const actionOptions = [
	{ value: 'insert', text: '新增', color: 'green' },
	{ value: 'update', text: '修改', color: 'blue' },
	{ value: 'soft_delete', text: '删除', color: 'red' },
	{ value: 'restore', text: '还原', color: 'cyan' },
];
/**
 * 审批状态与数据状态是两件事，分两列显示。
 *
 * 「无需审批」不是「已批准」：前台自助与路由显式声明的机器写入根本没进过队列。把它们
 * 显示成已批准，等于告诉看的人有个不存在的审批人点过头。
 */
const reviewOptions = [
	{ value: 'pending', text: REVIEW_LABELS.pending, color: 'gold' },
	{ value: 'approved', text: REVIEW_LABELS.approved, color: 'green' },
	{ value: 'none', text: REVIEW_LABELS.none, color: 'blue' },
	{ value: 'rejected', text: REVIEW_LABELS.rejected, color: 'red' },
	{ value: 'withdrawn', text: REVIEW_LABELS.withdrawn, color: 'default' },
];
const dataOptions = [
	{ value: 'applied', text: DATA_LABELS.applied, color: 'green' },
	{ value: 'unwritten', text: DATA_LABELS.unwritten, color: 'default' },
	{ value: 'reverted', text: DATA_LABELS.reverted, color: 'default' },
];
const scopeOptions = [
	{ value: 'admin', text: '后台操作', color: 'geekblue' },
	{ value: 'self', text: '用户自助', color: 'default' },
];
/**
 * 查询条件。**三个筛选都不预设默认值**：进来先看到全部。
 *
 * 「待审批」当过默认值，问题是它把这一页从「变更记录」悄悄变成了「待办列表」——
 * 刚提交完想确认一下记下来没有，翻半天以为没记；而真要处理积压，选一下筛选也只是一步。
 */
// 「全部」用显式哨兵值而不是空串：空串在 antd 的 Select 里等于「没有选中」，
// 选完会显示成空白。顺带让 URL 自解释——review_status=all 比 review_status= 一眼看得懂。
// 三个下拉框都不摆「全部」：空着就是不加这个条件，占位文字写着「未填写」。
// 「全部」是同一件事的第二种拼法，两种摆在一个控件里，看的人先得琢磨它们差在哪。
const queryFields = [
	{ dataIndex: 'review_status', label: '审批状态', component: 'select' as const, options: reviewOptions },
	{ dataIndex: 'data_status', label: '数据状态', component: 'select' as const, options: dataOptions },
	{ dataIndex: 'scope', label: '来源', component: 'select' as const, options: scopeOptions },
	{ dataIndex: 'table_name', label: '数据表', component: 'textbox' as const, placeholder: '例如 base_users' },
	{ dataIndex: 'row_id', label: '记录 ID', component: 'textbox' as const },
	{ dataIndex: 'reason', label: '操作原因', component: 'textbox' as const, placeholder: '模糊匹配，% 与 _ 是通配符' },
];

/**
 * 每个动作对应一次迁移，并且只对处在起点的行显示。
 *
 * 审批类动作看审批状态，数据类动作看数据状态——两列各管各的：一条「无需审批」的自助
 * 操作照样能回滚，而它压根没有可批准的申请。
 */
/**
 * 行上那一列的取值：待审批的分「我提的」和「别人提的」，其余按数据状态。
 *
 * `visibleWhen` 只看一个字段，而「批准/驳回/撤销该不该出现」同时取决于审批状态**和**
 * 是谁提的，因此把两根轴折成一列。待审批时数据状态恒为 unwritten，折起来不丢信息。
 */
const STAGE_FIELD = '_stage';

/**
 * 这一行的迁移记录值不值得点开：`''` 没有、`one` 一条、`many` 两条以上。
 *
 * **只有两条以上才给按钮。** 一条的时候列表上那一列「最近迁移」显示的就是它的全部
 * （时间、迁移类型、操作者、理由），点开只是把同一行字换个地方再看一遍；零条更不用说。
 * 时间线要到「先被谁驳回、又被谁放回队列、最后谁批的」才开始有信息。
 */
const TRANSITIONS_FIELD = '_transitions';

/**
 * **撤销与驳回互斥**：自己提的叫撤销，别人提的叫驳回，同一条记录上不会同时出现两个。
 *
 * 原先三个按钮对每一条待审批记录都出现，而提交人往往自己就有审批权，于是「撤销申请」和
 * 「驳回」并排摆着，读的人分不清该点哪个——它们本来就作用在不同的记录上。
 *
 * 批准自己提的那一份只给超级用户：其余人受四眼原则限制，点了必然被服务端挡回来（§13.5）。
 */
const flipActions = (superUser: boolean) => [
	{ key: 'approve' as const, label: '批准', from: superUser ? ['pending-other', 'pending-mine'] : ['pending-other'], confirm: '确认批准这条修改吗？批准后立即生效。' },
	{ key: 'reject' as const, label: '驳回', from: ['pending-other'], confirm: '确认驳回这条修改吗？数据不会被改动。' },
	// 「撤销」动的是还没生效的申请，「回滚」动的是已经生效的数据。全站只用「撤销」这一个词
	// ——行上原先叫「撤回」，同一件事两种说法，读的人会以为是两个动作。
	{ key: 'withdraw' as const, label: '撤销', from: ['pending-mine'], confirm: '确认撤销这条还没生效的申请吗？数据不会被改动。' },
	{ key: 'revert' as const, label: '回滚', from: ['applied'], confirm: '确认把这条已经生效的变更改回去吗？' },
	// 两个「往回走」在不同的轴上，名字分开：重新应用动数据（回滚的逆），恢复动申请（驳回/撤销的逆）。
	{ key: 'redo' as const, label: '重新应用', from: ['reverted'], confirm: '确认把这条回滚掉的变更再写回去吗？' },
	// 只对被否掉的**新增**开放：其余重新提交一次就是了（见 TRANSITIONS.requeue 的 insertOnly）。
	// 驳回是审批人的决定，可以由审批人收回；撤销是申请人自己收回的，只有他自己能再放回去。
	{ key: 'requeue' as const, label: '恢复', from: ['rejected-insert', 'withdrawn-insert-mine'], confirm: '确认把这条新增放回队列吗？那一行会从回收站回到待审批，等批准了才生效。' },
];

const columns = [
	// 列的先后与 prisma/base.prisma 里 base_audits 的字段顺序一致——两处对照着
	// 看时不用来回找。计算列排在它所依据的那一列的位置上（summary 之于 changes）。
	// 由 test:change-audit 守着，加了新列忘了对齐会直接报错。
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'created_duid', title: '操作者', emptyText: '系统' },
	{ dataIndex: 'owner_uid', title: '作用账号', emptyText: '无' },
	// 审批是按**一次操作**走的：同一个操作号的记录批准/驳回时一起处理。
	{ dataIndex: 'operation_id', title: '操作号' },
	{ dataIndex: 'reason', title: '操作原因' },
	{ dataIndex: 'scope', title: '来源', options: scopeOptions },
	{ dataIndex: 'request_hostname', title: '操作域名' },
	{ dataIndex: 'request_path', title: '操作接口' },
	{ dataIndex: 'table_name', title: '数据表' },
	{ dataIndex: 'row_id', title: '记录' },
	// 定位用的是 key 不是 row_id：追查时看的也该是它。
	{ dataIndex: 'row_key', title: '记录标识' },
	{ dataIndex: 'action', title: '动作', options: actionOptions },
	// changes 的位置。一列一行；multiline 模式带 pre-wrap 与三行折叠，改得多也不会撑爆表格。
	{ dataIndex: 'summary', title: '变更内容', tableDisplay: 'multiline' as const },
	{ dataIndex: 'review_status', title: '审批状态', options: reviewOptions },
	{ dataIndex: 'data_status', title: '数据状态', options: dataOptions },
	/**
	 * 迁移不再各占三列（谁、什么时候、为什么），而是一条一条追加到 base_audit_transitions。
	 *
	 * 列表上只显示**最后一次发生了什么**——横着摆十几列的时候，一条记录最多经历两三种
	 * 迁移，其余格子永远空着；而完整经过在详情页按时间线读，那才是一条审计记录该有的样子。
	 */
	{ dataIndex: 'last_transition', title: '最近迁移', tableDisplay: 'multiline' as const },
];

/** 一次迁移读成一行人话：`2026-09-06 10:00:00 批准(approve)（#7）：同意`。 */
const transitionLine = (transition: AuditTransitionRow) => {
	const at = new Date(Number(transition.created_at)).toISOString().replace('T', ' ').slice(0, 19);
	const who = transition.created_duid ? `（#${transition.created_duid}）` : '';
	return `${at} ${kindLabel(transition.kind)}${who}${transition.reason ? `：${transition.reason}` : ''}`;
};

const publicEntry = (row: AuditEntryRow, transitions: AuditTransitionRow[] = []) => ({
	id: row.id,
	created_at: row.created_at,
	table_name: row.table_name,
	row_id: row.row_id,
	row_key: row.row_key,
	// 发原文不发文案:颜色由 options 里的那一条决定,发中文的话对不上任何一个选项。
	action: row.action,
	summary: describeAuditChanges(parseAuditChanges(row)),
	operation_id: row.operation_id,
	reason: row.reason,
	// 没有 device-user 就是机器写的，与「有人操作但没留下 id」不是一回事，因此发 null。
	created_duid: row.created_duid,
	owner_uid: row.owner_uid,
	review_status: row.review_status,
	data_status: row.data_status,
	scope: row.scope,
	request_hostname: row.request_hostname,
	request_path: row.request_path,
	last_transition: transitions.length ? transitionLine(transitions[transitions.length - 1]) : '',
});

const readIds = async (c: Parameters<ApiHandler>[0], routeId?: string) => {
	if (routeId) return [routeId];
	const body = await c.req.json<unknown>().catch(() => []);
	return Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : [];
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	if (c.req.method === 'GET' && !params.id) {
		const filters: SqlCondition[] = [];
		// 下拉框没选就没这个参数，那就是不过滤。认不出来的值一律当没选——那多半是
		// 换了选项之后浏览器还留着旧地址。
		const picked = (name: string, options: ReadonlyArray<{ value: string }>) => {
			const value = c.req.query(name)?.trim();
			return value && options.some((option) => option.value === value) ? [{ column: name, value }] : [];
		};
		filters.push(...picked('review_status', reviewOptions), ...picked('data_status', dataOptions), ...picked('scope', scopeOptions));
		// 三个文本框都是三态：没这个参数不筛，空串找空的（`row_id` 在批准之前本来就是空的，
		// 「哪几条申请还没落到行上」正是靠它筛出来），有值按值筛。
		const builder = sql({ database });
		filters.push(...builder.search('table_name', c.req.query('table_name')?.trim()));
		filters.push(...builder.search('row_id', c.req.query('row_id')?.trim()));
		const reason = c.req.query('reason')?.trim();
		const rows = await listAuditEntries(database, filters, reason, undefined, tableSort(c));
		// 待审批的那几条要分出「我提的」和「别人提的」——比到人不比到设备，同一个人换台
		// 设备不该变成两个人（与四眼原则用同一把尺子）。
		const submitters = await submitterIdsOf(database, rows.map((row) => String(row.created_duid ?? '')));
		const me = String(c.get('currentUser')?.id ?? '');
		const mineRow = (row: AuditEntryRow) => Boolean(me) && submitters.get(String(row.created_duid ?? '')) === me;
		/**
		 * 被否掉的申请只有**新增**还能恢复，因此把 action 也折进这一列——其余的落到
		 * `closed`，一个按钮都不挂：它们重新提交一次就是了。
		 *
		 * 撤销分「我的」和「别人的」：只有申请人自己能把它放回队列。驳回不分——那是审批人
		 * 的决定，由有审批权的人收回。
		 */
		const stageOf = (row: AuditEntryRow) => {
			if (row.review_status === 'pending') return mineRow(row) ? 'pending-mine' : 'pending-other';
			if (row.review_status === 'rejected') return row.action === 'insert' ? 'rejected-insert' : 'closed';
			if (row.review_status === 'withdrawn') return row.action === 'insert' ? (mineRow(row) ? 'withdrawn-insert-mine' : 'withdrawn-insert-other') : 'closed';
			return row.data_status;
		};
		// 列表有条数上限，总数单独计一次——拿列表长度当总数会在超过上限时谎报。
		const totalRecords = await countAuditEntries(database, filters, reason);
		// 迁移经过在事件表里：一次 IN 查询取回来按记录分组，列表上只显示最后一条。
		const transitions = await auditTransitionsFor(database, rows.map((row) => String(row.id)));
		return apiResponse(c, 200, { table: {
			// 审计记录不可修改、不可删除，接口层因此没有新增、编辑与删除入口（§7.3）。
			// 这一页的动作本身就是审批机制，不经过审批门：撤销、批准、驳回走的是
			// runSystemSql，勾「立即生效」不改变任何行为，因此显式关掉这个勾选框。
			// 操作原因仍然要收：它会写进审批意见、回滚理由或重新应用理由。
			option: { rowKey: 'id', queryFields, actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 回滚不新开记录，而是把这一条翻到另一面；已回滚的再点一次就重新应用。
				// 回滚与重新应用是互斥的两个动作，一行上只显示其中适用的那个。
				toolbar: flipActions(isSuperUser(c)).map((action) => ({ key: action.key, label: `${action.label}选中记录`, confirm: action.confirm, selection: true })),
				row: [
					// 完整经过在弹窗里读：列表上只有「最近迁移」一行，而一条记录可能被驳回、
					// 恢复、批准、回滚、重新应用地翻好几轮。带上 audit_id，否则弹开的是全站事件。
					{ key: 'transitions', label: '迁移记录', modalPath: '/panel/admin/base/audit-transitions', modalComponent: 'table' as const, modalQueryFields: { audit_id: 'id' }, visibleWhen: { field: TRANSITIONS_FIELD, values: ['many'] } },
					...flipActions(isSuperUser(c)).map((action) => ({ key: action.key, label: action.label, confirm: action.confirm, visibleWhen: { field: STAGE_FIELD, values: action.from } })),
				],
			} },
			columns,
			dataSource: rows.map((row) => {
				const timeline = transitions.get(String(row.id)) ?? [];
				return {
					...publicEntry(row, timeline),
					[STAGE_FIELD]: stageOf(row),
					[TRANSITIONS_FIELD]: timeline.length > 1 ? 'many' : timeline.length ? 'one' : '',
				};
			}),
			totalRecords,
		} });
	}
	if (params.id && c.req.method === 'GET') {
		const row = await readAuditEntry(database, params.id);
		if (!row) return apiMessage(c, 404, '审计记录不存在');
		// 详情页给**完整时间线**：一条审计记录该读得出「先被谁驳回、又被谁放回队列、最后谁批的」。
		const timeline = (await auditTransitionsFor(database, [String(row.id)])).get(String(row.id)) ?? [];
		return apiResponse(c, 200, {
			...publicEntry(row, timeline),
			changes: publicAuditChanges(parseAuditChanges(row)),
			transitions: timeline.map((transition) => ({ kind: transition.kind, label: kindLabel(transition.kind), at: transition.created_at, duid: transition.created_duid ?? '', reason: transition.reason ?? '' })),
		});
	}
	const flip = c.req.method === 'POST' ? flipActions(isSuperUser(c)).find((action) => action.key === c.req.query('action')) : undefined;
	if (flip) {
		const ids = await readIds(c, params.id);
		if (!ids.length) return apiMessage(c, 400, `请选择要${flip.label}的记录`);
		// 批准与驳回是替别人的申请做决定，不能自己批自己；撤销申请与回滚不受这道判定管——
		// 前者是收回自己提的东西，后者动的是已经生效的数据，两者都另有各自的权限门。
		if (flip.key === 'approve' || flip.key === 'reject' || flip.key === 'withdraw') {
			const entries = await allSql<{ id: string; created_duid: string | null }>(database, sql({ database }).select({
				table: AUDIT_TABLE,
				columns: { id: { column: 'id', cast: 'text' }, created_duid: { column: 'created_duid', cast: 'text' } },
				where: [{ column: 'review_status', value: 'pending' }],
			}));
			const selected = entries.filter((entry) => ids.includes(String(entry.id)));
			// 撤销是把**自己**提的东西收回去。替别人撤等于替别人做决定，那是驳回该干的事——
			// 原先这一页谁都能撤谁的，与「撤销/驳回互斥」那条规则正好相反。
			if (flip.key === 'withdraw') {
				const submitters = await submitterIdsOf(database, selected.map((entry) => String(entry.created_duid ?? '')));
				const me = String(c.get('currentUser')?.id ?? '');
				const others = selected.filter((entry) => submitters.get(String(entry.created_duid ?? '')) !== me);
				if (others.length) return apiMessage(c, 403, `只能撤销自己提交的申请（选中的有 ${others.length} 条是别人提的，请用驳回）`);
			} else {
				const selfApproval = await assertNotSelfApproval(c, database, selected);
				if (selfApproval) return apiMessage(c, 403, selfApproval);
			}
		}
		const results = await transitionAuditEntries(database, ids, flip.key, readChangeReason(c));
		const failed = results.filter((result) => !result.ok);
		if (!failed.length) return apiMessage(c, 200, `已${flip.label} ${results.length} 条变更`);
		// 逐条独立判定：某一条被拒绝时其余照常执行，最后逐条返回结果（§7.4）。
		const detail = failed.map((result) => `#${result.id} ${result.message}`).join('；');
		return apiMessage(c, results.length === failed.length ? 409 : 200, `成功 ${results.length - failed.length} 条，失败 ${failed.length} 条：${detail}`);
	}
	return next();
};

export const acceptsTrailingParams = true;
/**
 * 审批记录自己也要有回收站。
 *
 * 这一页不给删除按钮（§7.3：审批记录不可删除），但「数据管理」能对任何表软删除，
 * 包括这一张。删掉之后它从这一页消失，而这一页恰恰是唯一会去看它的地方——
 * 没有回收站的话，「谁把审批记录删了」既看不见也找不回。
 *
 * 声明 tableCrud 还顺带把「待审批」标记和撤销/批准行动作接上：改一条审批记录同样要
 * 走审批（test:recycle-bin 覆盖），那条申请也该在这一页上看得见。
 */
export const tableCrud: TableCrudDefinition = { table: AUDIT_TABLE, rowKey: 'id' };
export default handler;
