import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { listColumns, listTables } from '@server/database/schema.mjs';
import { firstSql, runSql, sql, type SqlCondition } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperationSql } from './operation.mjs';
import { apiMessage } from './api-response.mjs';
import { deletedScopeFromQuery } from './query-options.mjs';
import { APPROVE_ACTION, PENDING_IDS_FIELD, REJECT_ACTION, WITHDRAW_ACTION, handlePendingApprovalAction } from './pending-approval.mjs';
import { isSuperUser } from './super-users.mjs';

export type TableCrudDatabase = 'database' | 'passportDatabase' | 'globalDatabase';
export type TableCrudValue = string | ((c: Context<AppEnv>) => string | undefined | Promise<string | undefined>);
export type TableCrudDefinition = {
	table: TableCrudValue;
	rowKey: TableCrudValue;
	database?: TableCrudDatabase;
	/** 限制回收站操作的业务归属条件，例如当前 Accounts 用户 ID。 */
	where?: (c: Context<AppEnv>) => SqlCondition[] | Promise<SqlCondition[]>;
};

export const tableCrudDatabase = (c: Context<AppEnv>, definition: TableCrudDefinition) => c.get(definition.database ?? 'database');

const resolveValue = async (c: Context<AppEnv>, value: TableCrudValue) => typeof value === 'function' ? value(c) : value;
const readIds = async (c: Context<AppEnv>, routeId?: string) => {
	if (routeId) return [routeId];
	const body = await c.req.json<unknown>().catch(() => []);
	return Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : [];
};

/** 处理所有 TableCRUD 共用的还原/彻底删除、撤销/批准/驳回动作；请求路径仍是原表格接口。 */
export const handleTableCrudAction = async (c: Context<AppEnv>, definition: TableCrudDefinition, routeId?: string): Promise<Response | undefined> => {
	if (c.req.method !== 'POST') return undefined;
	const pendingAction = c.req.query('action');
	if (pendingAction === WITHDRAW_ACTION || pendingAction === APPROVE_ACTION || pendingAction === REJECT_ACTION) {
		const database = tableCrudDatabase(c, definition);
		if (!database) return apiMessage(c, 503, '目标数据库不可用');
		const table = await resolveValue(c, definition.table);
		if (!table) return apiMessage(c, 400, '目标数据表未配置');
		const body = await c.req.json<unknown>().catch(() => undefined);
		const ids = routeId ? [routeId] : Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : [];
		if (!ids.length) return apiMessage(c, 400, '请选择要处理的记录');
		/**
		 * 页面上看到的是哪几条申请，由列表跟着行一起发下去（`_pending_ids`），点的时候原样带回。
		 *
		 * 只按行号解的话，服务端会在收到请求时重新问一遍「这一行有哪些待审批」——中间别人
		 * 又提了一条，点下去就连它一起处理了，而那一条操作者根本没看见。
		 */
		const selected = body && typeof body === 'object' && !Array.isArray(body)
			? String((body as Record<string, unknown>)[PENDING_IDS_FIELD] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
			: [];
		// 逐行处理：一行的申请撤不动不该连累其余的（§7.4）。
		const results = await Promise.all(ids.map((id) => handlePendingApprovalAction(c, table, id, selected)));
		const failed = results.flatMap((result) => result && !result.ok ? [result.message] : []);
		if (failed.length) return apiMessage(c, 409, failed.join('；'));
		return apiMessage(c, 200, pendingAction === APPROVE_ACTION ? '已批准并生效' : pendingAction === REJECT_ACTION ? '已驳回' : '已撤销');
	}
	if (deletedScopeFromQuery(c) !== 'deleted') return undefined;
	const action = c.req.query('action');
	if (action !== 'restore' && action !== 'purge') return undefined;
	const database = tableCrudDatabase(c, definition);
	if (!database) return apiMessage(c, 503, '目标数据库不可用');
	const table = await resolveValue(c, definition.table);
	const rowKey = await resolveValue(c, definition.rowKey);
	if (!table || !rowKey) return apiMessage(c, 400, '回收站目标数据表或主键未配置');
	const tables = await listTables(database);
	if (!tables.some((item) => item.name === table)) return apiMessage(c, 404, '数据表不存在');
	const columns = await listColumns(database, table);
	if (!columns.some((column) => column.name === 'deleted_at')) return apiMessage(c, 400, '该数据表不支持回收站');
	if (!columns.some((column) => column.name === rowKey)) return apiMessage(c, 400, '数据表主键不存在');
	const ids = await readIds(c, routeId);
	if (!ids.length) return apiMessage(c, 400, '请选择要操作的记录');
	// 彻底删除是全站唯一不可逆、也不留痕的操作（物理 delete 不审计，§3.0），因此只给
	// 超级用户——那份名单在 .env 里，拿到数据库的人改不了它。
	if (action === 'purge' && !isSuperUser(c)) return apiMessage(c, 403, '只有超级用户可以彻底删除记录');
	const businessWhere = await definition.where?.(c) ?? [];
	for (const id of ids) {
		const where: SqlCondition[] = [...businessWhere, { column: rowKey, value: id }, { column: 'deleted_at', operator: '!=', value: 0 }];
		const existing = await firstSql(database, sql({ database }).select({ table, columns: { id: rowKey }, where, deleted: 'deleted', limit: 1 }));
		if (!existing) return apiMessage(c, 404, `回收站中不存在记录：${id}`);
	}
	/**
	 * 恢复**照常走审批**，彻底删除不排队。
	 *
	 * 原先恢复是立即生效的，理由是「回收站得是后悔药，删错一条不该等审批人有空才救得回来」。
	 * 那个理由站不住：删除本身就要审批人签过字，所以删的时候已经等过一次了，「删错了」
	 * 不是一个随手就能造成的状态。而恢复是把一条**被批准删掉的**记录重新对所有人可见，
	 * 那是在推翻一个已经做过的决定，正是审批要管的事。
	 *
	 * 彻底删除仍然不排队也不留痕：物理 delete 不带审计元数据（§3.0），而它只给超级用户。
	 *
	 * 多条一起选时共用一个操作号并 defer：第一条就抛异常的话，后面几条根本不会进队列，
	 * 用户看到「已提交审批」却只提交了一条。
	 */
	const operationId = crypto.randomUUID();
	for (const id of ids) {
		const where: SqlCondition[] = [...businessWhere, { column: rowKey, value: id }, { column: 'deleted_at', operator: '!=', value: 0 }];
		const statement = action === 'restore' ? sql({ database }).restore(table, where) : sql({ database }).delete(table, where);
		await runOperationSql(c, database, statement, action === 'restore' ? { operationId, defer: true } : { immediate: true });
	}
	const pending = c.get('pendingApproval');
	if (pending?.operationId === operationId) throw new PendingApprovalError(pending.operationId, pending.entries);
	await c.get('siteRouter').refresh();
	return apiMessage(c, 200, action === 'restore' ? '记录已还原' : '记录已彻底删除');
};
