import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter, DatabaseRunResult } from '@server/database/index.mjs';
import { allSql, AUDIT_TABLE, firstSql, isUniqueViolation, runSystemSql, sql, type SqlAuditAction, type SqlAuditMetadata, type SqlCondition, type SqlInsertAuditMetadata, type SqlQuery } from '@server/database/sql.mjs';
import { isDigestValueColumn, isHiddenValueColumn } from '@shared/audit-tables.mjs';
import { serializeAuditChanges } from './audit.mjs';
import { isSystemField } from '@shared/system-fields.mjs';
import { normalizeApiPath } from './request-origin.mjs';
import { submitterIdsOf, submitterNames } from './super-users.mjs';

/**
 * 一次人工操作。
 *
 * 审计记录在这一层做，不在 runSql：只有这里知道这是哪个人、因为什么、
 * 这次操作包含哪几条写入。SqlBuilder 看到的只是一条 SQL 片段，靠表名列名
 * 反推「算不算人工操作」是代价高的猜测——同一张 passport_devices，登录时
 * 机器写是噪音，管理员吊销设备时人工写是证据（见需求文档 §3.0）。
 */
export type OperationOptions = {
	/** 操作原因；缺省时从请求头 X-Change-Reason 里取。 */
	reason?: string;
	/** 跳过审批直接生效；缺省时从请求头 X-Change-Immediate 里取，且只对管理员生效。 */
	immediate?: boolean;
	/**
	 * 同一次业务操作的多次调用共用一个操作号。
	 *
	 * 建号要写三行（账号、凭证、资料），而后两行的 user_id 要等账号行插进去才知道，
	 * 一次 runOperation 传不完。共用操作号之后，这三条记录批准/驳回时一起处理——
	 * 批一半就是「账号能登录但没有密码」。
	 */
	operationId?: string;
	/**
	 * 这次操作还要看住哪几行——**「这套记录」的身份行**。
	 *
	 * 行锁按 `(表名, 行号)` 判，可一个业务对象常常横跨几张表：用户是 `base_users` +
	 * `base_user_credentials` + `base_user_profiles` 三行。管理页上编辑「一个用户」，只改
	 * 昵称时压根不生成 `base_users` 的语句，于是别人挂在账号那一行上的申请拦不住这次修改——
	 * 从页面上看是同一条记录，锁却只锁住了其中一张表。
	 *
	 * 由路由声明，框架不猜：「哪几行算同一套」是业务知识。靠 `operation_id` 反查也能连起来，
	 * 但那连的是「曾经在同一次操作里被一起写过」，批量操作会把毫不相干的行也串上。
	 */
	lockRows?: ReadonlyArray<{ table: string; rowId: string | number | bigint }>;
	/**
	 * 进了队列也不抛异常，由调用方决定什么时候抛。
	 *
	 * 多步操作要接着往下走（账号行写完才拿得到 id），中途抛出去后面两行就不写了。
	 * 排队与否仍然记在 `c.get('pendingApproval')` 上，调用方据此收尾。
	 */
	defer?: boolean;
};

/**
 * 操作已记录为待审批、**没有执行**。
 *
 * 抛异常而不是返回状态码：路由后面那句 `return apiMessage(c, 200, '已保存')` 不能执行，
 * 否则会告诉用户改好了。异常一抛，业务路由一行都不用改（见需求文档 §11.5）。
 */
/**
 * 这一行的**存在性**还在等审批，不接受别的申请。
 *
 * 新增、删除、恢复决定的是「这一行在不在」；在那件事定下来之前再叠一条修改（或另一种
 * 存在性申请），审批人就得在脑子里合并几条记录才知道批准之后是什么样，而「驳回新增 +
 * 批准修改」这类组合根本没人想要——那条修改作用在一行已经进了回收站的记录上。
 *
 * 界面上会把编辑与删除按钮一并收起来，这一句是挡伪造请求的那道门：按钮不出现只是不
 * 引诱人去点。要改就先撤销。
 */
export class PendingLockError extends Error {
	constructor(readonly table: string, readonly action: string, readonly submitter?: string) {
		// 三句话，按知道多少说多少：知道是谁提的就说是谁（他只能等审批人处理），
		// 只知道动作就说动作（自己的那条撤了就能接着改），什么都不知道就笼统说——
		// 最后一种是数据库那条唯一索引兜底拦下的（见 base_approvals.settled_at），
		// 那时应用层的判定已经放行了，拿不到队列里那条的任何信息。
		super(submitter ? `${submitter}提交的「${action}」申请正在等待审批，这条记录暂时不能动——要先由审批人批准或驳回`
			: action ? `这一行有一条「${action}」申请正在等待审批，请先撤销或等它审批完再操作`
				: '这一行已经有一条申请在等待审批，一行上同时只能有一条——请先撤销或等它审批完再操作');
		this.name = 'PendingLockError';
	}
}

/**
 * 自助写入撞上了一行**还没生效**的记录（`pended_at` 非 0）。
 *
 * 这一行是别人提交的、还没批准的新建，对写它的人根本不可见。让他写下去的话，三件事同时
 * 发生：他看不到结果（那一行仍然不可见），于是反复改；每改一次都留下一条 `data_status`
 * 写着「已生效」的审计记录，而外面一个字都看不到——**审计表在说假话**；同时那条待审批的
 * 新建被他改掉了内容，审批人再去批准就撞上「内容与申请里的不一致」，那条申请成了死结。
 *
 * 与审批那一侧的前置条件是同一句话的两面：修改只作用在已经生效的那一行上。
 */
export class PendedRowError extends Error {
	constructor(readonly table: string) {
		super('这条记录正在等待审批、还没有生效，暂时不能修改——改了也不会生效');
		this.name = 'PendedRowError';
	}
}

export class PendingApprovalError extends Error {
	constructor(readonly operationId: string, readonly entries: number) {
		super('修改已提交审批，通过后才会生效');
		this.name = 'PendingApprovalError';
	}
}

/** 有权跳过审批的角色，与 §9 的回滚权限一致。 */
/** 能跳过审批的角色。「立即生效」与「立即批准」是同一件事的两个入口，共用这一道门。 */
export const APPROVAL_SKIP_ROLES = ['platform_admin', 'tenant_admin', 'branch_admin'];

const MAX_REASON_LENGTH = 500;

/**
 * 原因走请求头，不走请求体。
 *
 * 删除接口的请求体是一个 id 数组，塞不进字段；用请求头对所有请求形状都统一，
 * 业务路由也完全看不见它，不用改签名，也不会误把它当成业务字段。
 * 头部只能放 ASCII，因此客户端 encodeURIComponent 后再发。
 */
export const CHANGE_REASON_HEADER = 'x-change-reason';
export const readChangeReason = (c: Context<AppEnv>) => {
	const raw = c.req.header(CHANGE_REASON_HEADER);
	if (!raw) return '';
	try { return decodeURIComponent(raw).trim().slice(0, MAX_REASON_LENGTH); }
	catch { return raw.trim().slice(0, MAX_REASON_LENGTH); }
};

/**
 * 「立即生效」默认关闭：不勾就走审批。
 *
 * 是否放行由**服务端角色**说了算，不由请求头说了算——请求头只是勾选框的传递方式，
 * 非管理员就算伪造这个头也照样进审批队列。
 */
/**
 * 这次操作算后台还是用户自助。
 *
 * **与「要不要走审批」是同一条判定**，因此只算这一处：写进 base_approvals.scope 的值和
 * 审批门用的必须是同一个结论，各判各的迟早会漂移——那时候审计里记着「后台操作」，
 * 而它当初其实没进过队列。
 */
export const operationScope = (c: Context<AppEnv>) => c.req.path.startsWith('/api/panel/admin/') ? 'admin' as const : 'self' as const;

const skipsApproval = (c: Context<AppEnv>, options: OperationOptions) => {
	// 审批只适用于管理后台（需求文档 §11.2）。个人中心与账户中心的自助操作、注册引导、
	// 以及任何显式声明的操作都照常留痕但立即生效——那些要么是用户处置自己的数据，
	// 要么根本没有审批人可言（初始管理员注册时系统里一个账号都还没有）。
	if (operationScope(c) === 'self') return true;
	// 「立即生效」这个勾选框已废除：管理后台的修改一律进队列，有权限的人在待审批提示里
	// 点「批准并生效」。两条路做同一件事，留一条就够，而勾选框那条还得在每个表单里占一格。
	// options.immediate 仍保留给路由内部的机器写入（建号收尾之类）显式声明。
	return options.immediate === true;
};

/**
 * 比较用的归一形式。
 *
 * BIGINT 各驱动返回的类型不一致（number / string / bigint），一律按字符串比；
 * 数组与对象要按 JSON 比，`String(['a','b'])` 会得到 `a,b`，两个不同的数组可能撞上。
 */
const compareKey = (value: unknown) => {
	if (value === null || value === undefined) return null;
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
};
const sameValue = (left: unknown, right: unknown) => compareKey(left) === compareKey(right);

/** 三种动作都是 UPDATE，按写入的列区分：碰了 deleted_at 就是删除或恢复。 */
const actionOf = (changes: Record<string, { before: unknown; after: unknown }>): SqlAuditAction => {
	const deletedAt = changes.deleted_at;
	if (!deletedAt) return 'update';
	return Number(deletedAt.after ?? 0) === 0 ? 'restore' : 'soft_delete';
};

/**
 * 解析成 JSON 的数组或对象，解析不出来就返回 undefined。
 *
 * 只认数组与对象，不认数字、布尔、null——那几种会把普通文本列误判成 JSON
 * （`'123'` 会变成 123）。数组与对象则不会：一个业务字符串恰好以 `[` 或 `{`
 * 开头并且能整段解析，基本上就是 JSON。
 */
const asJson = (value: unknown) => {
	if (value !== null && typeof value === 'object') return value;
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (!text.startsWith('[') && !text.startsWith('{')) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
	} catch { return undefined; }
};

/**
 * 把前后值还原成**逻辑类型**。
 *
 * SQLite 没有 JSON 类型，`roles` 这类列以文本存储、读回来也是文本。写入侧的形态却
 * 不统一：路由层直接传数组，而「数据管理」的表单传的是 JSON 字符串。不还原的话，
 * **同一列会因为从哪个页面改而记成两种形态**——
 * `{"before":["a"],"after":["b"]}` 与 `{"before":"[\"a\"]","after":"[\"b\"]"}`。
 *
 * 因此只要写入侧能解析成 JSON，两边就都还原成对象或数组。回滚时写回对象同样正确：
 * 适配器会 JSON.stringify 后入库，WHERE 里的条件值走同一条路径，能和存储的文本对上。
 * 即便某个业务列的值恰好长得像 JSON（误判），来回一趟仍是同一串文本，回滚不受影响。
 */
const logicalPair = (stored: unknown, written: unknown): [unknown, unknown] => {
	const writtenJson = asJson(written);
	if (writtenJson === undefined) return [stored ?? null, written ?? null];
	return [asJson(stored) ?? stored ?? null, writtenJson];
};

const findPendingEntry = async (database: DatabaseAdapter, builder: ReturnType<typeof sql>, table: string, rowId: unknown, action: SqlAuditAction) => {
	const actor = builder.auditActor(AUDIT_TABLE);
	const where: SqlCondition[] = [
		{ column: 'table_name', value: table },
		{ column: 'row_id', value: rowId },
		{ column: 'review_status', value: 'pending' },
		/**
		 * **只覆盖同一个动作的申请。**
		 *
		 * 「后一次提交作废前一次」说的是同一件事被重说了一遍：改完再改，前一条申请自然作废。
		 * 但删除与修改是两件事——先申请删掉这一行、再申请改它的某几列，那是两个意图，
		 * 谁也不该把谁抹掉。不按动作分的话，后提交的修改会把前面那条删除申请**静悄悄改写**，
		 * 提交人以为两件都在队列里排着，实际只剩一件。
		 *
		 * 新建同理，而且后果更重：实测建号进队列后再改一次 status，那条 insert 被改写成
		 * update，于是批准时没有人再去把 pended_at 归零——行永远隐身，账号登不进去（401），
		 * 而审批列表显示一切正常。
		 */
		{ column: 'action', value: action },
		actor === null ? { column: 'created_duid', operator: 'IS NULL' } : { column: 'created_duid', value: actor },
	];
	return firstSql<{ id: string }>(database, builder.select({
		table: AUDIT_TABLE, columns: { id: { column: 'id', cast: 'text' } }, where,
		// 显式 active：回收站视图把适配器的默认范围设成 deleted，那说的是被浏览的那张表。
		// 不写的话，从回收站发起的操作会去「已删除的审批记录」里找同一行的待审批申请，
		// 永远找不到，于是同一个人对同一行的重复提交会在队列里堆成两条。
		deleted: 'active',
		orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
	}));
};

/**
 * 这一行上有没有**别的动作**的申请在等审批；有就返回它的中文名。
 *
 * **一行上同时只允许一种动作的申请。** 同一个动作重新提交是「重说一遍」，照旧覆盖；
 * 换一个动作就是叠加，一律挡住。
 *
 * 这条比「存在性申请挡住内容申请」更严，理由是按钮上写不下第二种动作：一行同时挂着
 * 「修改」和「删除」时，`?action=withdraw-pending` 这个请求本身说不清撤的是哪一件，
 * 而界面只显示得出一对按钮——点「撤销删除」却把别人那条修改也一起撤了。要么把动作也
 * 编进每一个请求里，要么根本不让这种局面出现；后者简单得多，代价只是「先撤销再改」。
 *
 * 不看是谁提的：一行的去留没定下来，谁来改都一样要等——挡的是「叠加」，不是「越权」。
 */
const PENDING_ACTION_LABELS: Record<string, string> = { insert: '新增', update: '修改', soft_delete: '删除', restore: '恢复' };

/**
 * 写一条审批记录。撞上「一行同时只能有一条在队列里」那条唯一索引时翻译成人话。
 *
 * 应用层的行锁（{@link findConflictingPending}）先查再写，挡不住两个请求同时进来，也认不出
 * 没有登录身份的模块级调用是谁；数据库那条约束不看这些，它兜的就是这两种情况。裸的
 * `UNIQUE constraint failed` 对看的人没有意义，因此在这里换成和行锁一致的说法。
 */
const writeAuditRow = async (database: DatabaseAdapter, table: string, statement: SqlQuery) => {
	try { await runSystemSql(database, statement); }
	catch (error) {
		if (!isUniqueViolation(error)) throw error;
		throw new PendingLockError(table, '');
	}
};

const findConflictingPending = async (database: DatabaseAdapter, builder: ReturnType<typeof sql>, table: string, rowId: unknown, action: SqlAuditAction, actorUserId: string) => {
	const rows = await allSql<{ action: string; created_duid: string | null }>(database, builder.select({
		table: AUDIT_TABLE, columns: { action: 'action', created_duid: { column: 'created_duid', cast: 'text' } },
		where: [
			{ column: 'table_name', value: table },
			{ column: 'row_id', value: rowId },
			{ column: 'review_status', value: 'pending' },
		],
		deleted: 'active',
	}));
	if (!rows.length) return undefined;
	/**
	 * **别人提的申请把这一行整个锁住：什么动作都不给做。**
	 *
	 * 这比 §13.6 那条「只允许一种动作」更狠一层，而且狠得有道理——那条规则挡的是「叠加」，
	 * 同一个动作的重新提交照旧放行（那是「重说一遍」，覆盖上一条）。可换成**别人**来重说
	 * 就完全变味了：他覆盖掉的是另一个人写的内容，而记录上的提交人还是原来那位，审批人
	 * 看到的申请署着甲的名、写着乙的字。改一份别人提交的、还没生效的新建（§13.7 的例外）
	 * 同理——那份草稿是别人的。
	 *
	 * 自己提的照旧：撤了就能接着改，那是同一个人对同一件事改主意。
	 *
	 * 比到人，不比到设备：`created_duid` 是设备用户，直接拿它比的话，同一个人换台设备就
	 * 成了「两个人」，自己反倒被自己锁住。与四眼原则（§13.5）用的是同一把尺子。
	 */
	const submitters = await submitterIdsOf(database, rows.map((row) => String(row.created_duid ?? '')));
	/**
	 * **认不出「我是谁」就不判这一层**，退回按动作判（下面那一段）。
	 *
	 * 没有登录身份的只有内部路径——迁移、种子、模块级调用。把它们一律当成「别人」的话，
	 * 一条待审批记录会把这一行对系统自己也锁死，连「同一个调用方重新提交」都做不成。
	 * 人际锁管的是人与人，没有人的地方它无话可说。真实的后台请求必然有 currentUser，
	 * 走不到这一支。
	 */
	const byOthers = actorUserId ? rows.filter((row) => submitters.get(String(row.created_duid ?? '')) !== actorUserId) : [];
	if (byOthers.length) {
		const label = PENDING_ACTION_LABELS[String(byOthers[0].action)] ?? String(byOthers[0].action);
		const names = await submitterNames(database, [...new Set(byOthers.map((row) => submitters.get(String(row.created_duid ?? '')) ?? ''))]);
		return { action: label, submitter: names.length ? names.join('、') : '另一个人' };
	}
	/**
	 * **改一份还没生效的新建不算叠加。** 那一行带着 pended_at，谁也看不见，改它没有任何
	 * 对外后果——所以放行，而且照 §13.6 立即写进去、不另开一条申请（见 draftInsertEntry）。
	 */
	const blocking = rows.map((row) => String(row.action))
		.find((pending) => pending !== action && !(pending === 'insert' && action === 'update'));
	return blocking ? { action: PENDING_ACTION_LABELS[blocking] ?? blocking, submitter: undefined } : undefined;
};

/**
 * 这一行有没有一条待审批的**新建**申请；有就返回它的 id 与已记下的内容。
 *
 * 有的话，随后的修改改的是一份还没生效的草稿：不新开申请，直接写进那一行，并把这条新建
 * 记录的 `changes` 刷新成最新内容——审批人看到的必须是他将要批准的那一份。
 */
const draftInsertEntry = async (database: DatabaseAdapter, builder: ReturnType<typeof sql>, table: string, rowId: unknown) => firstSql<{ id: string; changes_after: string }>(database, builder.select({
	table: AUDIT_TABLE, columns: { id: { column: 'id', cast: 'text' }, changes_after: 'changes_after' },
	where: [
		{ column: 'table_name', value: table },
		{ column: 'row_id', value: rowId },
		{ column: 'review_status', value: 'pending' },
		{ column: 'action', value: 'insert' },
	],
	deleted: 'active', orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
}));

type RequestOrigin = { hostname: string; path: string };

/**
 * 两侧都是普通对象时，只留变了的那几个键；否则返回 undefined，按整值记录。
 *
 * 嵌套对象整块留下：回滚要把这几个键原样写回去，留半截会把没提到的子键抹掉。
 * 顶层逐键已经足够回答「改了什么」，再往下拆只会让写回的逻辑变复杂。
 */
const jsonKeyDiff = (before: unknown, after: unknown) => {
	const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
	if (!isPlain(before) || !isPlain(after)) return undefined;
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
	if (!keys.length) return undefined;
	return {
		before: Object.fromEntries(keys.filter((key) => key in before).map((key) => [key, before[key]])),
		after: Object.fromEntries(keys.filter((key) => key in after).map((key) => [key, after[key]])),
	};
};

/**
 * 一条新建记录的 `changes_after`：**批准之后这一行会是什么样**。
 *
 * `changes_before` 是 `{}`——空对象本身就说清了「这一行之前不存在」，比一串 null 干净。
 *
 * **明文密钥一个都不进来**：client_secret、dsn 这类抄进审批表就会在那里躺满保留期，
 * 而它们对「我在批什么」毫无帮助。这里是不写入，比在显示时脱敏更彻底——库里根本没有。
 *
 * `password` 是例外：它存的本来就是摘要，抄的也是摘要（见 DIGEST_VALUE_COLUMNS）。换到
 * 两件事——批准前核得出「这一行的凭证还是不是提交时那一份」，以及审批人看得到密码规律。
 *
 * 归属列、时间戳与 `key` 也不写：前两样每一行都有，`key` 已经是「记录标识」那一列。
 *
 * **`pended_at` 也不写。** 它曾经写在这里，理由是「批准落到数据上就是这一列」。当时
 * `changes` 是一列，前值是提交时刻，读起来是 `pended_at: 1788636234201 → 0`，确实说明了
 * 一件事。现在三条支撑全没了：前后值分开存之后新建的 before 是 `{}`，它显示成
 * 「pended_at：空 → 0」，什么也没说；「恢复」改用此刻的时间戳，不再回读它；批准前的内容
 * 校验又必须把它排除掉——它正是那一步要改的那一列。留着就是一行纯噪音。
 */
const insertChanges = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values)
	.filter(([name, value]) => value !== undefined && value !== null && value !== ''
		&& !(isHiddenValueColumn(name) && !isDigestValueColumn(name)) && !isSystemField(name) && !name.startsWith('owner_'))
	.map(([name, value]) => [name, value]));

/**
 * 记一条「新建了这一行」。
 *
 * `changes` 里写的是**将要新增的内容**（隐藏列除外，见 insertChanges）：审批人要能看见
 * 自己在批什么。行虽然已经写进库里，但它带着 pended_at，在任何正常列表里都不可见——
 * 让审批人「自己去看那一行」是行不通的。
 *
 * 这些值只用来显示：批准是把 pended_at 归零、驳回是把那一行删掉，两者都不读 changes，
 * 因此少记几列不影响任何一步的正确性。
 *
 * 定位靠 `row_key`：它在建语句时就生成好了，所以这条记录能在**写行之前**落地，
 * 与 update 那边「先记录、后应用」是同一条顺序（§6.2）。
 */
const recordInsert = async (
	database: DatabaseAdapter,
	metadata: SqlInsertAuditMetadata,
	operationId: string,
	reason: string,
	origin: RequestOrigin,
	scope: 'admin' | 'self',
	immediate: boolean,
) => {
	const builder = sql({ database, subjectRoles: null, ownerTid: metadata.owner.tid, ownerBid: metadata.owner.bid, ownerUid: metadata.owner.uid, actorUid: metadata.owner.actor });
	await writeAuditRow(database, metadata.table, builder.insert(AUDIT_TABLE, {
		operation_id: operationId,
		reason,
		scope,
		request_hostname: origin.hostname,
		request_path: origin.path,
		table_name: metadata.table,
		// 行还没写进去，自增主键无从谈起；定位一律走 row_key。
		row_id: 0,
		row_key: metadata.rowKey,
		action: 'insert',
		changes_before: '{}',
		changes_after: JSON.stringify(insertChanges(metadata.values)),
		review_status: immediate ? 'none' : 'pending',
		data_status: immediate ? 'applied' : 'unwritten',
		// 进队列的记 0，那是唯一索引里的哨兵位；从未进过队列的一诞生就是了结的（见 settled_at）。
		settled_at: immediate ? Date.now() : 0,
	}));
	return 1;
};

/**
 * 把新建那条记录的 `row_id` 补上。
 *
 * 记录是在**行写进去之前**落的（§6.2 先记录后应用），那一刻自增主键还不存在，所以
 * `row_id` 先记 0、定位一律靠 `row_key`。行写成之后 id 就有了，补上它——否则审计页面的
 * 「记录」那一列对每一条新建都显示 0，看着像缺数据，也没法和数据管理里的 id 对上。
 *
 * **补上了也不拿它当定位依据**：`rowCondition` 仍然是 key 优先，因为 row_id 跨库搬迁会变。
 *
 * 不用驱动返回的 lastRowId:四种方言里 SQLite 和 MySQL 给得出，PostgreSQL 的适配器不返回
 * （它要 RETURNING，而适配器没做）。审计里出现「有的表有、有的表没有」比多一次按 key 的
 * 索引查询糟糕得多。
 */
const backfillInsertRowId = async (
	database: DatabaseAdapter,
	builder: ReturnType<typeof sql>,
	metadata: SqlInsertAuditMetadata,
	operationId: string,
) => {
	if (!metadata.rowKey) return;
	// deleted/pended 都放开：待审批的新行 pended_at 非零，普通查询正好看不见它。
	const row = await firstSql<{ id: string }>(database, builder.select({
		table: metadata.table,
		columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'key', value: metadata.rowKey }],
		deleted: 'all', pended: 'all', limit: 1,
	}));
	if (!row?.id) return;
	await runSystemSql(database, builder.update(AUDIT_TABLE, { row_id: row.id }, [
		{ column: 'operation_id', value: operationId },
		{ column: 'table_name', value: metadata.table },
		{ column: 'row_key', value: metadata.rowKey },
	]));
};

/**
 * 记一条修改。返回 `{ recorded, found }`：
 *
 * - `recorded` 是真的写进审批表的条数（逐列比下来没变化就是 0）；
 * - `found` 是**匹配到几行**。两者必须分开：upsert 靠 `found === 0` 判断这次走的是 INSERT
 *   那一支，而「行在、只是一个字都没改」同样 recorded 为 0，混作一谈会把它记成新增。
 */
const recordStatement = async (database: DatabaseAdapter, metadata: SqlAuditMetadata, operationId: string, reason: string, origin: RequestOrigin, scope: 'admin' | 'self', immediate: boolean, actorUserId: string) => {
	// 归属与可见性条件都在生成语句时定死了：调用方可能用显式上下文覆盖适配器。
	const builder = sql({ database, subjectRoles: null, ownerTid: metadata.owner.tid, ownerBid: metadata.owner.bid, ownerUid: metadata.owner.uid, actorUid: metadata.owner.actor });
	const columns = Object.keys(metadata.values);
	// deleted: 'all' 与 update 的行为对齐——恢复操作要能读到已删除的原行。
	// 一律 cast 成文本：BIGINT 是雪花号，按数字读会溢出。
	let recorded = 0, drafted = false;
	const rows = await allSql<Record<string, unknown>>(database, builder.select({
		table: metadata.table,
		// key 一起读出来：审批记录靠它定位那一行——row_id 在跨库搬迁后会变，key 不会。
		// pended_at 一起读：这一行生没生效决定了自助写入该不该落下去（见 PendedRowError）。
		columns: Object.fromEntries(['id', 'key', 'pended_at', ...columns].map((column) => [column, { column, cast: 'text' as const }])),
		where: metadata.where,
		deleted: 'all',
	}));
	for (const row of rows) {
		const changes: Record<string, { before: unknown; after: unknown }> = {};
		// 这一列写下去之后的**完整值**。改草稿时要用它，不能用上面那份差异——
		// JSON 列的 after 只有变了的那几个键，拿它去覆盖新建记录里的整块配置，
		// 「批准之后这一行是什么样」就只剩一个片段了。
		const written: Record<string, unknown> = {};
		// 只记实际发生变化的列：业务表单常整体提交，照单全收会让"改了什么"失去答案。
		for (const column of columns) {
			const [before, after] = logicalPair(row[column], metadata.values[column]);
			if (sameValue(before, after)) continue;
			written[column] = after;
			// JSON 列只记**变了的那几个键**：改一个页脚而把整块站点配置抄进审计，
			// 「改了什么」等于没答，记录也会随配置一起膨胀。
			// 回滚时按键合并回去，不整块覆盖，见 audit.mts 的 transitionOne。
			changes[column] = jsonKeyDiff(before, after) ?? { before, after };
		}
		if (!Object.keys(changes).length) continue;
		const values = {
			operation_id: operationId,
			reason,
			scope,
			request_hostname: origin.hostname,
			request_path: origin.path,
			table_name: metadata.table,
			row_id: row.id,
			row_key: String(row.key ?? ''),
			action: actionOf(changes),
			...serializeAuditChanges(changes),
			// 「没人批过」不叫「已批准」：直接生效的记录审批状态是 none，
			// approved 只留给真的走完队列的那些。
			review_status: immediate ? 'none' : 'pending',
			data_status: immediate ? 'applied' : 'unwritten',
			settled_at: immediate ? Date.now() : 0,
		};
		// 覆盖这个人自己挂在这一行上的待审批记录，不管新提交是继续排队还是立即生效。
		//
		// 排队的情况：队列里堆着同一个人对同一行的多份申请，审批人只能逐条批过去，
		// 而先批的那几条会因为值校验（§7.2）全部失败——它们的 before 是更早的值。
		// 立即生效的情况：他已经自己把这一行改掉了，原先那条申请随之作废，留着就是
		// 一条谁也批不动的孤儿记录（before 已经对不上）。两种情况都是同一件事的最新版本。
		/**
		 * 这一行已经有申请在排队时，只接受**同一个动作**的重新提交（那是「重说一遍」，照旧覆盖）。
		 *
		 * 只在走审批的路径上判：立即生效的自助操作不排队，也不该被后台的待审批申请挡住。
		 */
		if (!immediate) {
			const blocking = await findConflictingPending(database, builder, metadata.table, row.id, values.action, actorUserId);
			if (blocking) throw new PendingLockError(metadata.table, blocking.action, blocking.submitter);
		}
		/**
		 * **自助写入也只作用在已经生效的那一行上。**
		 *
		 * 上面那道锁只管走审批的路径——自助不排队，本来也不该被后台的待审批申请挡住。但
		 * 「这一行还没生效」是另一回事：它对写的人根本不可见，写下去的结果他也看不见，
		 * 于是反复改，每次留一条说假话的审计记录，顺带把那条待审批的新建改成死结
		 * （见 PendedRowError）。
		 *
		 * 只挡 `scope === 'self'`，不挡 `options.immediate` 那种路由内部的机器写入：
		 * 建号收尾正是要往自己刚插进去的、还没生效的行上补 `user_id`，挡了它建号就断在半路。
		 */
		if (scope === 'self' && String(row.pended_at ?? '0') !== '0') throw new PendedRowError(metadata.table);
		/**
		 * 改的是一份**还没生效的新建**：不另开申请，把内容并进那条新建记录，语句照常执行。
		 *
		 * 那一行带着 pended_at，谁也看不见，改它没有任何对外后果——再排一次队只会让审批人
		 * 面对两条记录，还得自己在脑子里合并出「批准之后是什么样」。合进去之后队列里始终
		 * 一条，写的就是最终内容。
		 *
		 * 「谁改过草稿」不单独留痕，落在那一行的 `updated_duid` / `updated_at` 上。
		 */
		if (!immediate && values.action === 'update') {
			const draft = await draftInsertEntry(database, builder, metadata.table, row.id);
			if (draft) {
				// 只并 after 那一份：新建记录的 before 恒为 `{}`，改草稿改的是「将要新增什么」。
				const merged: Record<string, unknown> = (() => { try { const parsed = JSON.parse(draft.changes_after) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } })();
				for (const [column, value] of Object.entries(written)) merged[column] = value;
				await runSystemSql(database, builder.update(AUDIT_TABLE, { changes_after: JSON.stringify(merged) }, [{ column: 'id', value: draft.id }, { column: 'review_status', value: 'pending' }]));
				drafted = true;
				continue;
			}
		}
		const existing = await findPendingEntry(database, builder, metadata.table, row.id, values.action);
		if (existing) await runSystemSql(database, builder.update(AUDIT_TABLE, values, [{ column: 'id', value: existing.id }, { column: 'review_status', value: 'pending' }]));
		else await writeAuditRow(database, metadata.table, builder.insert(AUDIT_TABLE, values));
		recorded += 1;
	}
	return { recorded, found: rows.length, drafted };
};

/**
 * 记录并执行一次人工操作。
 *
 * 无事务可用，因此**顺序是强制的：先记录，后应用**——中断留下"记了但没做"
 * 可被发现和核对，"做了但没记"则事后无法察觉（见需求文档 §6.2）。
 * 记录失败时整个操作失败：不允许"审计写不进去就跳过"。
 */
export const runOperation = async (
	c: Context<AppEnv>,
	database: DatabaseAdapter,
	statements: readonly SqlQuery[],
	options: OperationOptions = {},
): Promise<DatabaseRunResult[]> => {
	const managed = statements.filter((statement) => statement.audit !== undefined || statement.insertAudit !== undefined);
	// 新建单独一路：它没有前值可读，靠 row_key 定位，待审批时把行写成不可见的。
	// upsert 两种元数据都带，落到哪一路要查过才知道，因此这个数组在记录时才填。
	const inserts: (SqlQuery & { insertAudit: SqlInsertAuditMetadata })[] = [];
	// 改的是还没生效的草稿：不进队列，但语句要执行（见 recordStatement 里的 draftInsertEntry）。
	const drafts: SqlQuery[] = [];
	const immediate = managed.length === 0 || skipsApproval(c, options);
	// 「谁在操作」只在这一处取：行锁要比到人（见 findConflictingPending）。
	const actorUserId = String(c.get('currentUser')?.id ?? '');
	/**
	 * 身份行的锁先判：这次操作一个字都还没写，撞上就整次拒掉。
	 *
	 * 放在这里而不是 recordStatement 里，是因为那一层按语句走——只改昵称时根本没有
	 * `base_users` 的语句可走，也就没有地方去看那一行上的锁。而且新建走的是另一条路
	 * （recordInsert），在这里判两条路都覆盖得到。
	 */
	if (!immediate && options.lockRows?.length) {
		const lockBuilder = sql({ database });
		for (const target of options.lockRows) {
			const blocking = await findConflictingPending(database, lockBuilder, target.table, String(target.rowId), 'update', actorUserId);
			if (blocking) throw new PendingLockError(target.table, blocking.action, blocking.submitter);
		}
	}
	let recorded = 0, operationId = '', pendedAt = 0;
	if (managed.length) {
		operationId = options.operationId ?? crypto.randomUUID();
		const reason = options.reason?.trim().slice(0, MAX_REASON_LENGTH) ?? readChangeReason(c);
		// 域名与接口路径都由服务端自己看到，不听客户端的：页面路径要靠 referer 推断，
		// 那是客户端说什么就是什么，写进审计等于给伪造留了口子。
		//
		// 解析不出来就记空串，不让它把整次写入带塌：留痕是为了留下证据，
		// 为了一个"从哪来"的字段而使操作失败，是本末倒置。
		const origin: RequestOrigin = (() => {
			try {
				const url = new URL(c.req.url);
				// 记去掉后缀的逻辑路径：`.php` 是站点可配的接口后缀，同一个接口在不同站点
				// 可能是 /api/panel/me.php、/api/panel/me.json 或干脆没有后缀。记原样的话，
				// 同一件事在审计里长出好几种写法，按路径筛选也就筛不干净。
				//
				// 用路由匹配那一侧的同一个函数（normalizeApiPath）：这里原先自己写了一版
				// `endsWith`，对集合地址好使，对成员地址 `/…/users.php/2` 一个字都剥不掉——
				// 后缀在中间。同一件事两套算法，走偏的那一套就是这么留下带 `.php` 的记录的。
				const path = normalizeApiPath(url.pathname, c.get('techStackConfig')?.apiSuffix ?? '');
				return { hostname: url.hostname, path };
			} catch { return { hostname: '', path: '' }; }
		})();
		const scope = operationScope(c);
		// 待审批的新行写进去时带的就是这个时刻。
		pendedAt = immediate ? 0 : Date.now();
		const asInsert = async (statement: SqlQuery & { insertAudit: SqlInsertAuditMetadata }) => {
			inserts.push(statement);
			recorded += await recordInsert(database, statement.insertAudit, operationId, reason, origin, scope, immediate);
		};
		for (const statement of managed) {
			if (statement.audit) {
				const result = await recordStatement(database, statement.audit, operationId, reason, origin, scope, immediate, actorUserId);
				// 改草稿的语句照常执行：它没有进队列，而排队分支只写新建那几行就抛异常了。
				if (result.drafted) drafts.push(statement);
				/**
				 * 一行都没匹配到而这条语句又带着 insertAudit：那就是 upsert 走了 INSERT 那一支。
				 *
				 * 这条路上有两处：个人中心第一次设昵称（资料行还不存在），以及**后台每一项配置的
				 * 第一次保存**（配置行还不存在）。两处原先都完全不留痕——审计那一层是按修改的
				 * 形状记的，读不到前值就当作「什么都没改」，于是语句被直接执行掉。
				 *
				 * 后台那一侧因此曾经有个洞：第一次保存既不进队列也不留痕，从第二次起才正常。
				 * 现在两条路一视同仁——走审批的就记成一条待审批的新建，页面显示默认值加一条
				 * 「有 1 项修改正在等待审批」，与第二次保存的表现一致。
				 */
				if (!result.found && statement.insertAudit) await asInsert(statement as SqlQuery & { insertAudit: SqlInsertAuditMetadata });
				else recorded += result.recorded;
				continue;
			}
			if (statement.insertAudit) await asInsert(statement as SqlQuery & { insertAudit: SqlInsertAuditMetadata });
		}
	}
	// 待审批：记录已写，数据一条都不动。逐列比对下来没有任何变化时 recorded 为 0，
	// 那本来就不是一次修改，不该拦下来让人去批一个空操作。
	if (!immediate && recorded > 0) {
		// 已经排过队就把条数累加上去：一次业务操作分几次调用时，202 里报的是总条数。
		const already = c.get('pendingApproval');
		// 新建的行照写，只是带上 pended_at 让它不可见——批准就是把它归零。
		// 值因此不必抄进审批表，凭证也就不会在那里躺满保留期。
		for (const statement of inserts) {
			const builder = sql({ database, subjectRoles: null, ownerTid: statement.insertAudit.owner.tid, ownerBid: statement.insertAudit.owner.bid, ownerUid: statement.insertAudit.owner.uid, actorUid: statement.insertAudit.owner.actor });
			try {
				// 照原样重建那条 INSERT，只多一个 pended_at——不重新走 insert()，那会再发一个 key，
				// 而审批记录里记的是原来那一个。
				await runSystemSql(database, builder.insertExisting(statement.insertAudit.table, { ...statement.insertAudit.values, pended_at: pendedAt }));
				await backfillInsertRowId(database, builder, statement.insertAudit, operationId);
			} catch (error) {
				/**
				 * 行没写成（多半是撞了唯一索引），把刚记下的那条申请撤掉。
				 *
				 * 这不违反「先记录后应用」：那条原则防的是**中断**——记了但不知道做没做，
				 * 留着才能核对。这里是**已知的失败**，行确定不存在，留下的申请谁也批不动，
				 * 只会在待审批列表里冒充一件待办。物理删掉而不是标记，因为它从未成立过。
				 */
				await runSystemSql(database, builder.delete(AUDIT_TABLE, [
					{ column: 'operation_id', value: operationId },
					{ column: 'table_name', value: statement.insertAudit.table },
					{ column: 'row_key', value: statement.insertAudit.rowKey },
				]));
				throw error;
			}
		}
		// 除了抛异常，还在上下文里留个标记：万一某处 catch 把异常吞了，最外层中间件
		// 仍会把响应改成 202。正确性不能依赖「每一处 catch 都记得重新抛出」。
		for (const statement of drafts) await runSystemSql(database, statement);
		const entries = (already?.operationId === operationId ? already.entries : 0) + recorded;
		c.set('pendingApproval', { operationId, entries });
		if (options.defer) return [];
		throw new PendingApprovalError(operationId, entries);
	}
	const results: DatabaseRunResult[] = [];
	for (const statement of statements) results.push(await runSystemSql(database, statement));
	// 立即生效的新建（个人中心、注册引导这类 self 作用域）同样要补 row_id：
	// 记录一样是先写的，那时也还没有主键。
	if (operationId) {
		for (const statement of inserts) {
			const builder = sql({ database, subjectRoles: null, ownerTid: statement.insertAudit.owner.tid, ownerBid: statement.insertAudit.owner.bid, ownerUid: statement.insertAudit.owner.uid, actorUid: statement.insertAudit.owner.actor });
			await backfillInsertRowId(database, builder, statement.insertAudit, operationId);
		}
	}
	return results;
};

/** 单条语句的简写，与 runSql 的调用形状一一对应。 */
export const runOperationSql = async (c: Context<AppEnv>, database: DatabaseAdapter, statement: SqlQuery, options: OperationOptions = {}) =>
	(await runOperation(c, database, [statement], options))[0];
