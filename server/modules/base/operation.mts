import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter, DatabaseRunResult } from '@server/database/index.mjs';
import { allSql, AUDIT_TABLE, runSystemSql, sql, type SqlAuditAction, type SqlAuditMetadata, type SqlQuery } from '@server/database/sql.mjs';

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
};

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

/** 驱动对 BIGINT 的返回类型不一致（number / string / bigint），归一成字符串再比。 */
const sameValue = (left: unknown, right: unknown) => {
	if (left === null || left === undefined) return right === null || right === undefined;
	if (right === null || right === undefined) return false;
	return String(left) === String(right);
};

/** 三种动作都是 UPDATE，按写入的列区分：碰了 deleted_at 就是删除或恢复。 */
const actionOf = (changes: Record<string, { before: unknown; after: unknown }>): SqlAuditAction => {
	const deletedAt = changes.deleted_at;
	if (!deletedAt) return 'update';
	return Number(deletedAt.after ?? 0) === 0 ? 'restore' : 'soft_delete';
};

const recordStatement = async (database: DatabaseAdapter, metadata: SqlAuditMetadata, operationId: string, reason: string) => {
	// 归属与可见性条件都在生成语句时定死了：调用方可能用显式上下文覆盖适配器。
	const builder = sql({ database, subjectRoles: null, ownerTid: metadata.owner.tid, ownerBid: metadata.owner.bid, ownerUid: metadata.owner.uid, actorUid: metadata.owner.actor });
	const columns = Object.keys(metadata.values);
	// deleted: 'all' 与 update 的行为对齐——恢复操作要能读到已删除的原行。
	// 一律 cast 成文本：BIGINT 是雪花号，按数字读会溢出。
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
			const before = row[column] ?? null, after = metadata.values[column] ?? null;
			if (!sameValue(before, after)) changes[column] = { before, after };
		}
		if (!Object.keys(changes).length) continue;
		await runSystemSql(database, builder.insert(AUDIT_TABLE, {
			operation_id: operationId,
			reason,
			table_name: metadata.table,
			row_id: row.id,
			action: actionOf(changes),
			changes: JSON.stringify(changes),
			status: 'applied',
		}));
	}
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
	if (audited.length) {
		const operationId = crypto.randomUUID();
		const reason = options.reason?.trim().slice(0, MAX_REASON_LENGTH) ?? readChangeReason(c);
		for (const statement of audited) await recordStatement(database, statement.audit, operationId, reason);
	}
	const results: DatabaseRunResult[] = [];
	for (const statement of statements) results.push(await runSystemSql(database, statement));
	return results;
};

/** 单条语句的简写，与 runSql 的调用形状一一对应。 */
export const runOperationSql = async (c: Context<AppEnv>, database: DatabaseAdapter, statement: SqlQuery, options: OperationOptions = {}) =>
	(await runOperation(c, database, [statement], options))[0];
