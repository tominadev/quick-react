import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { firstSql, isNotNullViolation, isUniqueViolation, runSql, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperationSql } from '@server/modules/base/operation.mjs';
import { assertTable, databaseQueryFields, databaseSelectColumns, databaseTableActions, getColumns, readTable, tableRowKey } from '@server/routes/base/data/database-table.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { isSystemField } from '@shared/system-fields.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

const body = async (c: Parameters<ApiHandler>[0]) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
const editableFields = (values: Record<string, unknown>, names: Set<string>) => Object.entries(values).filter(([name]) => names.has(name));
const protectedFields = (values: Record<string, unknown>, allowKey = false) =>
	Object.keys(values).filter((name) => isSystemField(name) && !(allowKey && name === 'key'));
/**
 * 撞唯一索引给 409，其余原样抛出去。
 *
 * 待审批那条异常必须放行：它不是失败，是「记下了、没执行」，由外层中间件改写成 202。
 * 别的错误也不吞——把真正的服务端故障说成「已经有一条一样的了」，比 500 更难查。
 */
const duplicateOr = (c: Parameters<ApiHandler>[0], error: unknown, message: string) => {
	if (error instanceof PendingApprovalError) throw error;
	// 「这一列必须填」和撞唯一索引一样是输入的正常结果，回 500 会让人以为是服务端坏了。
	// 数据管理页直接对着原始表写，NOT NULL 是这里最容易撞上的约束。
	if (isNotNullViolation(error)) return apiMessage(c, 400, '有必填的列没有给值：这一列不允许为空');
	if (!isUniqueViolation(error)) throw error;
	return apiMessage(c, 409, message);
};

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
	if (params.id && c.req.method === 'GET' && tableName) {
		try { await assertTable(database, tableName); } catch { return apiMessage(c, 404, '数据表不存在'); }
		const info = await getColumns(database, tableName);
		let rowKey: string;
		try { rowKey = tableRowKey(database, info); } catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '数据表不能编辑'); }
		const sqliteRowId = rowKey === 'rowid';
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: tableName, columns: databaseSelectColumns(info), sqliteRowIdAlias: sqliteRowId ? '__rowid__' : undefined, where: [{ column: rowKey, value: params.id }], limit: 1, queued: 'all' }));
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
		try { await runOperationSql(c, database, sql({ database }).update(tableName, Object.fromEntries(values), { [rowKey]: params.id })); }
		catch (error) { return duplicateOr(c, error, '改成了一个已经被占用的值（唯一索引冲突）'); }
		return apiMessage(c, 200, '保存成功');
	}
	if (c.req.method === 'POST') {
		const source = await body(c);
		// 表单里的 key 留空就当没填：那张表的 key 是发号器发的，不该逼人手填一串雪花。
		if (typeof source.key === 'string' && !source.key.trim()) delete source.key;
		const protectedNames = protectedFields(source, true);
		if (protectedNames.length) return apiMessage(c, 400, `系统字段不可修改：${protectedNames.join('、')}`);
		const values = editableFields(source, names);
		if (!values.length) return apiMessage(c, 400, '没有可写入的字段');
		try { await runOperationSql(c, database, sql({ database }).insert(tableName, Object.fromEntries(values))); }
		catch (error) { return duplicateOr(c, error, '已经有一条一样的记录了（唯一索引冲突）'); }
		return apiMessageData(c, 201, '新增成功', {});
	}
	if (c.req.method === 'DELETE') {
		const ids = await c.req.json<unknown>().catch(() => []);
		if (!Array.isArray(ids)) return apiMessage(c, 400, '删除参数无效');
		/**
		 * **删了几行要如实报。**
		 *
		 * 原先无条件回「删除成功」，不看语句改没改到行——对着一个已经删掉的 id、一个不存在的
		 * id、或者一行当前主体看不见的记录点删除，得到的都是「删除成功，可在回收站找回」，
		 * 而回收站里什么也没有。静默失败比报错难查得多：人会以为删掉了。
		 *
		 * 进了审批队列的那一路不走到这里（runOperation 抛 PendingApprovalError）。
		 */
		let removed = 0;
		for (const id of ids) {
			const result = await runOperationSql(c, database, sql({ database }).softDelete(tableName, { [rowKey]: String(id) }));
			removed += Number(result?.meta?.changes ?? 0);
		}
		if (!removed) return apiMessage(c, 404, '没有匹配到要删除的记录：可能它已经删掉了，或者当前身份看不到它');
		return apiMessage(c, 200, `删除成功 ${removed} 条，可在回收站找回或彻底删除`);
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
