import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, runSql, sql } from '@server/database/sql.mjs';
import { runOperationSql } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

const columns = [
	{ dataIndex: 'id', title: 'ID' },
	{ dataIndex: 'device', title: '设备' },
	{ dataIndex: 'platform', title: '平台' },
	{ dataIndex: 'ip_address', title: '最近 IP' },
	{ dataIndex: 'status', title: '状态' },
	{ dataIndex: 'last_seen_at', title: '最近活动', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' }];

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('passportDatabase');
	if (!database) return apiMessage(c, 503, 'Accounts 数据库不可用');
	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'passport_devices', columns: { id: { column: 'id', cast: 'text' }, device: 'user_agent', platform: 'platform', ip_address: 'ip_address', last_seen_at: 'last_seen_at', status: 'status' }, sort: tableSort(c), orderBy: [{ column: 'last_seen_at', direction: 'DESC' }] }));
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { row: [{ key: 'delete', label: '注销设备', confirm: '注销后该设备的所有 Passport 会话将立即失效，确认注销？' }] } }, columns, dataSource: rows.map((row) => ({ ...row, device: String(row.device || '未知浏览器'), status: row.status === 'active' ? '正常' : '已注销' })), totalRecords: rows.length } });
	}
	if (c.req.method === 'DELETE') {
		const ids = params.id ? [params.id] : await c.req.json<unknown>().then((value) => Array.isArray(value) ? value.map(String) : []).catch(() => []);
		if (!ids.length) return apiMessage(c, 400, '请选择要注销的设备');
		for (const id of ids) {
			const now = Date.now();
			await runOperationSql(c, database, sql({ database }).update('passport_devices', { status: 'revoked', revoked_at: now }, { id, status: 'active' }));
			await runOperationSql(c, database, sql({ database }).update('passport_device_users', { status: 'revoked', revoked_at: now }, { device_id: id, status: 'active' }));
			await runSql(database, sql({ database }).delete('passport_sessions', { device_id: id }));
		}
		return apiMessage(c, 200, '设备已注销');
	}
	return next();
};

/**
 * 注销设备走的是审批（`runOperationSql`），因此这一页**必须**登记 tableCrud。
 *
 * 公共层靠它决定挂不挂撤销/批准/驳回（见 api-response.mts 的 withPendingApproval），也靠它
 * 接住那三个动作的请求。不登记的话，注销会进审批队列，而这一页上没有任何按钮能撤销或批准
 * 它——申请提了出不去，只能去审计记录页找。
 *
 * 列表与注销仍由本文件自己处理：公共层只在 POST 且带那几个 action 时才介入。
 */
export const tableCrud: TableCrudDefinition = { table: 'passport_devices', rowKey: 'id' };

export const acceptsTrailingParams = true;
export default handler;
