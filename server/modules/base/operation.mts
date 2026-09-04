import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter, DatabaseRunResult } from '@server/database/index.mjs';
import { allSql, AUDIT_TABLE, firstSql, runSystemSql, sql, type SqlAuditAction, type SqlAuditMetadata, type SqlCondition, type SqlQuery } from '@server/database/sql.mjs';

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
};

/**
 * 操作已记录为待审批、**没有执行**。
 *
 * 抛异常而不是返回状态码：路由后面那句 `return apiMessage(c, 200, '已保存')` 不能执行，
 * 否则会告诉用户改好了。异常一抛，业务路由一行都不用改（见需求文档 §11.5）。
 */
export class PendingApprovalError extends Error {
	constructor(readonly operationId: string, readonly entries: number) {
		super('修改已提交审批，通过后才会生效');
		this.name = 'PendingApprovalError';
	}
}

/** 有权跳过审批的角色，与 §9 的撤回权限一致。 */
const APPROVAL_SKIP_ROLES = ['platform_admin', 'tenant_admin', 'branch_admin'];

const MAX_REASON_LENGTH = 500;

/**
 * 原因走请求头，不走请求体。
 *
 * 删除接口的请求体是一个 id 数组，塞不进字段；用请求头对所有请求形状都统一，
 * 业务路由也完全看不见它，不用改签名，也不会误把它当成业务字段。
 * 头部只能放 ASCII，因此客户端 encodeURIComponent 后再发。
 */
export const CHANGE_REASON_HEADER = 'x-change-reason';
export const CHANGE_IMMEDIATE_HEADER = 'x-change-immediate';
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
const skipsApproval = (c: Context<AppEnv>, options: OperationOptions) => {
	// 审批只适用于管理后台（需求文档 §11.2）。个人中心与账户中心的自助操作、注册引导、
	// 以及任何显式声明的操作都照常留痕但立即生效——那些要么是用户处置自己的数据，
	// 要么根本没有审批人可言（初始管理员注册时系统里一个账号都还没有）。
	if (!c.req.path.startsWith('/api/panel/admin/')) return true;
	const requested = options.immediate ?? c.req.header(CHANGE_IMMEDIATE_HEADER) === '1';
	if (!requested) return false;
	return (c.get('effectiveRoles') ?? []).some((role) => APPROVAL_SKIP_ROLES.includes(role));
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
 * 因此只要写入侧能解析成 JSON，两边就都还原成对象或数组。撤回时写回对象同样正确：
 * 适配器会 JSON.stringify 后入库，WHERE 里的条件值走同一条路径，能和存储的文本对上。
 * 即便某个业务列的值恰好长得像 JSON（误判），来回一趟仍是同一串文本，撤回不受影响。
 */
const logicalPair = (stored: unknown, written: unknown): [unknown, unknown] => {
	const writtenJson = asJson(written);
	if (writtenJson === undefined) return [stored ?? null, written ?? null];
	return [asJson(stored) ?? stored ?? null, writtenJson];
};

const findPendingEntry = async (database: DatabaseAdapter, builder: ReturnType<typeof sql>, table: string, rowId: unknown) => {
	const actor = builder.auditActor(AUDIT_TABLE);
	const where: SqlCondition[] = [
		{ column: 'table_name', value: table },
		{ column: 'row_id', value: rowId },
		{ column: 'status', value: 'pending' },
		actor === null ? { column: 'created_duid', operator: 'IS NULL' } : { column: 'created_duid', value: actor },
	];
	return firstSql<{ id: string }>(database, builder.select({
		table: AUDIT_TABLE, columns: { id: { column: 'id', cast: 'text' } }, where,
		orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
	}));
};

const recordStatement = async (database: DatabaseAdapter, metadata: SqlAuditMetadata, operationId: string, reason: string, status: 'applied' | 'pending') => {
	// 归属与可见性条件都在生成语句时定死了：调用方可能用显式上下文覆盖适配器。
	const builder = sql({ database, subjectRoles: null, ownerTid: metadata.owner.tid, ownerBid: metadata.owner.bid, ownerUid: metadata.owner.uid, actorUid: metadata.owner.actor });
	const columns = Object.keys(metadata.values);
	// deleted: 'all' 与 update 的行为对齐——恢复操作要能读到已删除的原行。
	// 一律 cast 成文本：BIGINT 是雪花号，按数字读会溢出。
	let recorded = 0;
	const rows = await allSql<Record<string, unknown>>(database, builder.select({
		table: metadata.table,
		columns: Object.fromEntries(['id', ...columns].map((column) => [column, { column, cast: 'text' as const }])),
		where: metadata.where,
		deleted: 'all',
	}));
	for (const row of rows) {
		const changes: Record<string, { before: unknown; after: unknown }> = {};
		// 只记实际发生变化的列：业务表单常整体提交，照单全收会让"改了什么"失去答案。
		for (const column of columns) {
			const [before, after] = logicalPair(row[column], metadata.values[column]);
			if (!sameValue(before, after)) changes[column] = { before, after };
		}
		if (!Object.keys(changes).length) continue;
		const values = {
			operation_id: operationId,
			reason,
			table_name: metadata.table,
			row_id: row.id,
			action: actionOf(changes),
			changes: JSON.stringify(changes),
			status,
		};
		// 覆盖这个人自己挂在这一行上的待审批记录，不管新提交是继续排队还是立即生效。
		//
		// 排队的情况：队列里堆着同一个人对同一行的多份申请，审批人只能逐条批过去，
		// 而先批的那几条会因为值校验（§7.2）全部失败——它们的 before 是更早的值。
		// 立即生效的情况：他已经自己把这一行改掉了，原先那条申请随之作废，留着就是
		// 一条谁也批不动的孤儿记录（before 已经对不上）。两种情况都是同一件事的最新版本。
		const existing = await findPendingEntry(database, builder, metadata.table, row.id);
		if (existing) await runSystemSql(database, builder.update(AUDIT_TABLE, values, [{ column: 'id', value: existing.id }, { column: 'status', value: 'pending' }]));
		else await runSystemSql(database, builder.insert(AUDIT_TABLE, values));
		recorded += 1;
	}
	return recorded;
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
	const audited = statements.filter((statement): statement is SqlQuery & { audit: SqlAuditMetadata } => statement.audit !== undefined);
	const immediate = audited.length === 0 || skipsApproval(c, options);
	let recorded = 0, operationId = '';
	if (audited.length) {
		operationId = crypto.randomUUID();
		const reason = options.reason?.trim().slice(0, MAX_REASON_LENGTH) ?? readChangeReason(c);
		for (const statement of audited) recorded += await recordStatement(database, statement.audit, operationId, reason, immediate ? 'applied' : 'pending');
	}
	// 待审批：记录已写，数据一条都不动。逐列比对下来没有任何变化时 recorded 为 0，
	// 那本来就不是一次修改，不该拦下来让人去批一个空操作。
	if (!immediate && recorded > 0) {
		// 除了抛异常，还在上下文里留个标记：万一某处 catch 把异常吞了，最外层中间件
		// 仍会把响应改成 202。正确性不能依赖「每一处 catch 都记得重新抛出」。
		c.set('pendingApproval', { operationId, entries: recorded });
		throw new PendingApprovalError(operationId, recorded);
	}
	const results: DatabaseRunResult[] = [];
	for (const statement of statements) results.push(await runSystemSql(database, statement));
	return results;
};

/** 单条语句的简写，与 runSql 的调用形状一一对应。 */
export const runOperationSql = async (c: Context<AppEnv>, database: DatabaseAdapter, statement: SqlQuery, options: OperationOptions = {}) =>
	(await runOperation(c, database, [statement], options))[0];
