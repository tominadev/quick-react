import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, runSql, sql } from '@server/database/sql.mjs';
import { listColumns } from '@server/database/schema.mjs';

type Config = { table: string; key: string; columns: Record<string, unknown>[]; writable: string[]; prepareColumns?: (database: Parameters<typeof allSql>[0]) => Promise<Record<string, unknown>[]> };

export const pveCrud = (config: Config): ApiHandler => async (c, next, params) => {
	const database = c.get('database');
	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql(database).select({ table: config.table, orderBy: [{ column: config.key }] }));
		const schema = await listColumns(database, config.table);
		const required = new Set(schema.filter((column) => column.notnull && !column.pk && column.defaultValue === undefined).map((column) => column.name));
		const columnsWithRules = config.columns.map((column) => required.has(String(column.dataIndex)) && !column.rules ? { ...column, rules: [{ required: true, message: `请输入${String(column.title ?? column.dataIndex)}` }] } : column);
		const preparedColumns = config.prepareColumns ? await config.prepareColumns(database) : columnsWithRules;
		const columns = preparedColumns.map((column) => required.has(String(column.dataIndex)) && !column.rules ? { ...column, rules: [{ required: true, message: `请输入${String(column.title ?? column.dataIndex)}` }] } : column);
		return apiResponse(c, 200, { table: { option: { rowKey: config.key, actions: { toolbar: [{ key: 'create', label: '新增' }], row: [{ key: 'edit', label: '编辑' }] } }, columns, dataSource: rows, totalRecords: rows.length } });
	}
	if (c.req.method === 'GET' && params.id) {
		const row = await firstSql<Record<string, unknown>>(database, sql(database).select({ table: config.table, where: [{ column: config.key, value: params.id }] }));
		if (!row) return apiMessage(c, 404, '请求的资源不存在');
		return apiResponse(c, 200, row);
	}
	if (c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const schema = await listColumns(database, config.table);
		const required = schema.filter((column) => column.notnull && !column.pk && column.defaultValue === undefined).map((column) => column.name);
		const missing = required.filter((field) => body[field] === undefined || body[field] === null || (typeof body[field] === 'string' && !body[field].trim()));
		if (missing.length) return apiMessage(c, 400, `请填写必填字段：${missing.join('、')}`);
		const values: Record<string, unknown> = {};
		for (const field of config.writable) values[field] = body[field];
		const now = Date.now();
		if (!params.id) { values.created_at = now; values.updated_at = now; await runSql(database, sql(database).insert(config.table, values)); return apiMessage(c, 201, '创建成功'); }
		values.updated_at = now; await runSql(database, sql(database).update(config.table, values, { [config.key]: params.id })); return apiMessage(c, 200, '保存成功');
	}
	return next();
};
