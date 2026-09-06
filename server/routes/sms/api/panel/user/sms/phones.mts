import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 我的手机：用户自己绑定的那几部。
 *
 * **这一页不新增**：绑定要靠用户手上的 Shortcut 与令牌完成——手机装上文件、用令牌调
 * 接收接口，服务端才认得那部手机（绑定文档 §6）。在这里凭空插一行手机号，对应的
 * Shortcut 并不存在，那部手机一条短信也发不进来。
 *
 * 能做的是**改名、停收、解绑**：
 *
 * - 停收（`disabled`）是临时的，关系保留，用户自己能恢复；
 * - 解绑（`revoked`）终止关系，不可恢复，只能重新走一次绑定。重新绑同一个号码之所以
 *   可行，靠的是 `number` 那条带 `deleted_at` 的唯一索引（见 sms_phones.number）。
 *
 * 都不走审批：这一层在 `/api/panel/user/` 下，`operationScope` 判成自助，立即生效。
 * 手机绑定要是排进队列，那一行会带着非 0 的 `queued_at` 对正常查询不可见，而 Shortcut
 * 发来的短信正要靠查它认领归属——排队期间短信会被拒收。
 */

const STATUS_OPTIONS = [
	{ value: 'enabled', text: '正常接收', color: 'green' },
	{ value: 'disabled', text: '已停收', color: 'gold' },
	{ value: 'revoked', text: '已解绑', color: 'red' },
];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	// 手机号是本表的名字列（NAME_COLUMNS 里登记成 number）。它由绑定流程写入，改不得：
	// 改掉就成了「把这部手机的短信记到另一个号上」。
	{ dataIndex: 'number', title: '手机号', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'title', title: '设备名称', component: 'textbox' as const, emptyText: '未命名', placeholder: '给自己看的名字，如「备用机」' },
	{ dataIndex: 'status', title: '状态', component: 'select' as const, options: STATUS_OPTIONS,
		// 解绑不可逆，选项里给出来但配了确认文案；下拉里没有别的路径能改回 revoked。
		placeholder: '停收可以自行恢复；解绑不可恢复' },
	{ dataIndex: 'bound_at', title: '绑定时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'revoked_at', title: '解绑时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '未解绑', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_phones', rowKey: 'id' };

const listColumns = {
	id: { column: 'id', cast: 'text' as const }, number: 'number', title: 'title', status: 'status',
	bound_at: 'bound_at', revoked_at: 'revoked_at', created_at: 'created_at',
} as const;

const publicPhone = (row: Record<string, unknown>) => ({
	id: row.id, number: row.number, title: row.title || null, status: row.status,
	bound_at: Number(row.bound_at ?? 0) || null,
	revoked_at: Number(row.revoked_at ?? 0) || null,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	/**
	 * **只看自己的。** 公共层的归属判定已经会按 `owner_uid` 收敛，这里再写一次条件是
	 * 因为这一页的语义就是「我的手机」——判定将来若放宽（例如让分站管理员代看），
	 * 这一页也不该跟着放宽。两道锁不冲突，少一道才危险。
	 */
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	const mine = () => ownerScope('owner_uid', currentUser.id);

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_phones', columns: listColumns, where: [mine()],
			sort: tableSort(c), orderBy: [{ column: 'id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 没有「新增」：绑定要靠手机上的 Shortcut 与令牌走一遍，这里插不出来。
				toolbar: [],
				row: [{ key: 'edit', label: '编辑' }],
			} },
			columns, dataSource: rows.map(publicPhone), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_phones', columns: listColumns, where: [{ column: 'id', value: params.id }, mine()],
		}));
		return row ? apiResponse(c, 200, publicPhone(row)) : apiMessage(c, 404, '手机不存在');
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const row = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, status: 'status' },
			where: [{ column: 'id', value: params.id }, mine()],
		}));
		if (!row) return apiMessage(c, 404, '手机不存在');
		if (row.status === 'revoked') return apiMessage(c, 409, '这部手机已经解绑，重新绑定请在手机上再走一次 Shortcut');
		const changed = getChangedFields(body, ['title', 'status']);
		const values: Record<string, unknown> = {};
		if (changed.has('title')) values.title = String(body.title ?? '').trim().slice(0, 64);
		if (changed.has('status')) {
			const status = String(body.status ?? '');
			if (!['enabled', 'disabled', 'revoked'].includes(status)) return apiMessage(c, 400, '状态只能是正常接收、已停收或已解绑');
			values.status = status;
			// 解绑时间由服务端写，不收前端的值：它是「什么时候终止的」这一事实，不是一个可填字段。
			if (status === 'revoked') values.revoked_at = Date.now();
		}
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		// 带上原状态做条件：两个标签页同时改同一部手机，只有一个会真的落到行上。
		await runOperation(c, database, [sql({ database }).update('sms_phones', values, [
			{ column: 'id', value: params.id }, { column: 'status', value: row.status }, mine(),
		])]);
		return apiMessage(c, 200, values.status === 'revoked' ? '已解绑，这部手机不再接收短信' : '已保存');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的手机');
		for (const id of ids) await runOperationSql(c, database, sql({ database }).softDelete('sms_phones', [{ column: 'id', value: id }, mine()]));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
