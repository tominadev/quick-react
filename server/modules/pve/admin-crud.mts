import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, runSql, sql } from '@server/database/sql.mjs';

type Config = { table: string; key: string; columns: Record<string, unknown>[]; writable: string[]; prepareColumns?: (database: Parameters<typeof allSql>[0]) => Promise<Record<string, unknown>[]> };

export const pveCrud = (config: Config): ApiHandler => async (c, next, params) => {
	const database = c.get('database');
	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql(database).select({ table: config.table, orderBy: [{ column: config.key }] }));
		const columns = config.prepareColumns ? await config.prepareColumns(database) : config.columns;
		return apiResponse(c, 200, { table: { option: { rowKey: config.key, actions: { toolbar: [{ key: 'create', label: '新增' }], row: [{ key: 'edit', label: '编辑' }] } }, columns, dataSource: rows, totalRecords: rows.length } });
	}
	if (c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const values: Record<string, unknown> = {};
		for (const field of config.writable) values[field] = body[field];
		const now = Date.now();
		if (!params.id) { values.created_at = now; values.updated_at = now; await runSql(database, sql(database).insert(config.table, values)); return apiMessage(c, 201, '创建成功'); }
		values.updated_at = now; await runSql(database, sql(database).update(config.table, values, { [config.key]: params.id })); return apiMessage(c, 200, '保存成功');
	}
	return next();
};
