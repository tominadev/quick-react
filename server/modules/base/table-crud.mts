import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { listColumns, listTables } from '@server/database/schema.mjs';
import { firstSql, runSql, sql, type SqlCondition } from '@server/database/sql.mjs';
import { runOperationSql } from './operation.mjs';
import { apiMessage } from './api-response.mjs';
import { deletedScopeFromQuery } from './query-options.mjs';
import { APPROVE_ACTION, WITHDRAW_ACTION, handlePendingApprovalAction } from './pending-approval.mjs';

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

/** 处理所有 TableCRUD 共用的恢复/彻底删除、撤回申请/立即批准动作；请求路径仍是原表格接口。 */
export const handleTableCrudAction = async (c: Context<AppEnv>, definition: TableCrudDefinition, routeId?: string): Promise<Response | undefined> => {
	if (c.req.method !== 'POST') return undefined;
	const pendingAction = c.req.query('action');
	if (pendingAction === WITHDRAW_ACTION || pendingAction === APPROVE_ACTION) {
		const database = tableCrudDatabase(c, definition);
		if (!database) return apiMessage(c, 503, '目标数据库不可用');
		const table = await resolveValue(c, definition.table);
		if (!table) return apiMessage(c, 400, '目标数据表未配置');
		const ids = await readIds(c, routeId);
		if (!ids.length) return apiMessage(c, 400, '请选择要处理的记录');
		// 逐行处理：一行的申请撤不动不该连累其余的（§7.4）。
		const results = await Promise.all(ids.map((id) => handlePendingApprovalAction(c, table, id)));
		const failed = results.flatMap((result) => result && !result.ok ? [result.message] : []);
		if (failed.length) return apiMessage(c, 409, failed.join('；'));
		return apiMessage(c, 200, pendingAction === APPROVE_ACTION ? '已批准并生效' : '已撤回申请');
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
	const businessWhere = await definition.where?.(c) ?? [];
	for (const id of ids) {
		const where: SqlCondition[] = [...businessWhere, { column: rowKey, value: id }, { column: 'deleted_at', operator: '!=', value: 0 }];
		const existing = await firstSql(database, sql({ database }).select({ table, columns: { id: rowKey }, where, deleted: 'deleted', limit: 1 }));
		if (!existing) return apiMessage(c, 404, `回收站中不存在记录：${id}`);
	}
	for (const id of ids) {
		const where: SqlCondition[] = [...businessWhere, { column: rowKey, value: id }, { column: 'deleted_at', operator: '!=', value: 0 }];
		const statement = action === 'restore' ? sql({ database }).restore(table, where) : sql({ database }).delete(table, where);
		// 回收站里的恢复**立即生效**，只留痕不排队。
		//
		// 把记录移进回收站那一步已经过了审批（软删除是 UPDATE，走审批门）；恢复是它的
		// 逆操作，做的是「把东西放回大家都看得见的地方」。再让它排一次队，回收站就不是
		// 后悔药了——删错一条要等审批人有空才救得回来，而这段时间里记录是消失的。
		await runOperationSql(c, database, statement, { immediate: true });
	}
	await c.get('siteRouter').refresh();
	return apiMessage(c, 200, action === 'restore' ? '记录已恢复' : '记录已彻底删除');
};
