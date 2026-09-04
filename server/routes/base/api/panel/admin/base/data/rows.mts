import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { runOperationSql } from '@server/modules/base/operation.mjs';
import { assertTable, databaseQueryFields, databaseSelectColumns, databaseTableActions, getColumns, readTable, tableRowKey } from '@server/routes/base/data/database-table.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { isSystemField } from '@shared/system-fields.mjs';
import { isWriteProtectedTable } from '@shared/audit-tables.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

const body = async (c: Parameters<ApiHandler>[0]) => c.req.json<Record<string, unknown>>().catch(() => ({}));
const editableFields = (values: Record<string, unknown>, names: Set<string>) => Object.entries(values).filter(([name]) => names.has(name));
const protectedFields = (values: Record<string, unknown>) => Object.keys(values).filter(isSystemField);

export const tableCrud: TableCrudDefinition = {
	table: (c) => c.req.query('table'),
	rowKey: async (c) => {
		const tableName = c.req.query('table');
		if (!tableName) return undefined;
		try { return tableRowKey(c.get('database'), await getColumns(c.get('database'), tableName)); }
		catch { return undefined; }
	},
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const tableName = c.req.query('table');
	// 审计表只能由审计模块自己写。这一页直接操作原始表、绕过全部业务语义，
	// 放行等于让平台管理员随手改写自己的操作记录（§7.3）。
	if (c.req.method !== 'GET' && tableName && isWriteProtectedTable(tableName)) return apiMessage(c, 403, '审计记录不可修改、不可删除，只能随保留期过期');
	if (params.id && c.req.method === 'GET' && tableName) {
		try { await assertTable(database, tableName); } catch { return apiMessage(c, 404, '数据表不存在'); }
		const info = await getColumns(database, tableName);
		let rowKey: string;
		try { rowKey = tableRowKey(database, info); } catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '数据表不能编辑'); }
		const sqliteRowId = rowKey === 'rowid';
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: tableName, columns: databaseSelectColumns(info), sqliteRowIdAlias: sqliteRowId ? '__rowid__' : undefined, where: [{ column: rowKey, value: params.id }], limit: 1 }));
		return row ? apiResponse(c, 200, row) : apiMessage(c, 404, '数据不存在');
	}
	if (c.req.method === 'GET') {
		const result = await readTable(database, 'rows', tableName, c.req.query('pageNum'), c.req.query('pageSize'));
		const site = c.get('site');
		const { tables, editable, ...table } = result;
		return apiResponse(c, 200, { table: { ...table, option: { ...table.option, actions: databaseTableActions(editable), queryFields: databaseQueryFields(database, site.databaseTarget.kind === 'binding', tables) } } });
	}
	if (!tableName) return apiMessage(c, 400, '请选择数据表');
	try { await assertTable(database, tableName); } catch { return apiMessage(c, 404, '数据表不存在'); }
	const info = await getColumns(database, tableName);
	const names = new Set(info.map((column) => column.name));
	let rowKey: string;
	try { rowKey = tableRowKey(database, info); } catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '数据表不能编辑'); }
	if (params.id && c.req.method === 'PUT') {
		const source = await body(c);
		const protectedNames = protectedFields(source);
		if (protectedNames.length) return apiMessage(c, 400, `系统字段不可修改：${protectedNames.join('、')}`);
		const changedFields = getChangedFields(source, [...names]);
		const values = editableFields(source, changedFields);
		if (!values.length) return apiMessage(c, 400, '没有可更新的字段');
		await runOperationSql(c, database, sql({ database }).update(tableName, Object.fromEntries(values), { [rowKey]: params.id }));
		return apiMessage(c, 200, '保存成功');
	}
	if (c.req.method === 'POST') {
		const source = await body(c);
		const protectedNames = protectedFields(source);
		if (protectedNames.length) return apiMessage(c, 400, `系统字段不可修改：${protectedNames.join('、')}`);
		const values = editableFields(source, names);
		if (!values.length) return apiMessage(c, 400, '没有可写入的字段');
		await runSql(database, sql({ database }).insert(tableName, Object.fromEntries(values)));
		return apiMessageData(c, 201, '新增成功', {});
	}
	if (c.req.method === 'DELETE') {
		const ids = await c.req.json<unknown>().catch(() => []);
		if (!Array.isArray(ids)) return apiMessage(c, 400, '删除参数无效');
		for (const id of ids) await runOperationSql(c, database, sql({ database }).softDelete(tableName, { [rowKey]: String(id) }));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
