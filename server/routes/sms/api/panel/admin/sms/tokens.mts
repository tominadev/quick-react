import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { createCloudStorageAdapter, loadCloudStorageTargetByPurpose } from '@server/modules/global/cloud/resolve.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * Shortcut 令牌池。
 *
 * **这一页不新增令牌**：令牌连同 `.shortcut` 文件由生成器那台 Mac 一起产出，服务端只
 * 拿得到哈希（绑定文档 §5.1 的四步收敛）。凭空登记一条哈希，对应的文件并不存在，
 * 领的人下载不到东西。
 *
 * 能做的是**撤销**：把一条令牌作废，绑着它的手机随之收不到短信。撤销走审批，与这一层
 * 下面所有的写入一样。
 */

const STATUS_OPTIONS = [
	{ value: 'pending', text: '待确认', color: 'default' },
	{ value: 'available', text: '可领取', color: 'green' },
	{ value: 'bound', text: '已绑定', color: 'blue' },
	{ value: 'revoked', text: '已撤销', color: 'red' },
];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	// 哈希摆前 12 位：够在几千条里认出是哪一条，又不必让 64 个字符把表格撑开。
	// 原文服务端也没有——库里存的就是哈希。
	{ dataIndex: 'token_digest', title: '令牌哈希', ellipsis: true, form: { create: false as const, edit: false as const } },
	{ dataIndex: 'phone_id', title: '绑定手机', dataType: 'int' as const, emptyText: '未绑定', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'status', title: '状态', options: STATUS_OPTIONS, form: { create: false as const, edit: false as const } },
	{ dataIndex: 'revoke', title: '撤销', component: 'switch' as const, checkedValue: true, uncheckedValue: false,
		hideInTable: true, form: { create: false as const, edit: { title: '撤销这个令牌' } },
		placeholder: '打开并保存后立即作废，绑着它的手机不再能提交短信' },
	{ dataIndex: 'size_bytes', title: '文件大小', dataType: 'int' as const, emptyText: '无文件', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'last_used_at', title: '最近提交', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_shortcut_tokens', rowKey: 'id' };

const listColumns = {
	id: { column: 't.id', cast: 'text' as const }, token_sha256: 't.token_sha256', status: 't.status',
	phone_id: { column: 't.phone_id', cast: 'text' as const }, last_used_at: 't.last_used_at', created_at: 't.created_at',
	object_key: 'a.object_key', size_bytes: 'a.size_bytes', artifact_status: 'a.status',
} as const;
/**
 * 文件元数据挂在 `sms_shortcut_artifacts` 上，一个令牌可能有多个版本（换发时递增 `version`，
 * 旧版本置为 `revoked`）。只连 `ready` 的那一条：撤销过的文件不该还能下载。
 */
const listJoins = [{ type: 'LEFT' as const, table: 'sms_shortcut_artifacts', alias: 'a', left: 'a.token_id', right: 't.id', on: [{ column: 'a.status', value: 'ready' }] }];

const publicToken = (row: Record<string, unknown>) => ({
	id: row.id,
	token_digest: `${String(row.token_sha256 ?? '').slice(0, 12)}…`,
	status: row.status,
	phone_id: row.phone_id ?? null,
	revoke: false,
	size_bytes: Number(row.size_bytes ?? 0) || null,
	// 没有文件的令牌下不了：pending 状态的登记了哈希但文件还没确认上传（绑定文档 §5.1）。
	has_artifact: row.object_key ? '1' : '0',
	last_used_at: Number(row.last_used_at ?? 0) || null,
	created_at: row.created_at,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_shortcut_tokens', alias: 't', columns: listColumns, joins: listJoins,
			sort: tableSort(c), orderBy: [{ column: 't.id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 没有「新增」：令牌由生成器产出，这里凭空登记一条哈希是找不到文件的。
				toolbar: [{ key: 'delete', label: '删除' }],
				// 下载只对**有文件**的令牌显示：pending 状态的登记了哈希、文件还没确认上传，
				// 给个按钮点下去只会拿到一个 404（绑定文档 §5.1 的四步收敛）。
				row: [
					{ key: 'download', label: '下载', visibleWhen: { field: 'has_artifact', values: ['1'] } },
					{ key: 'edit', label: '编辑' },
					{ key: 'delete', label: '删除' },
				],
			} },
			columns, dataSource: rows.map(publicToken), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_shortcut_tokens', alias: 't', columns: listColumns, joins: listJoins, where: [{ column: 't.id', value: params.id }],
		}));
		return row ? apiResponse(c, 200, publicToken(row)) : apiMessage(c, 404, '令牌不存在');
	}

	/**
	 * 下载这个令牌的 `.shortcut` 文件。
	 *
	 * 前端的下载动作发到**集合地址**并带 `?key=<行主键>`（见 table_crud 的 download），
	 * 与 `/:id` 上的撤销不冲突。签出来的是一个 15 分钟过期的临时地址，文件本身始终在私有
	 * Bucket 里——**不能改成公开读**：`.shortcut` 文件里就装着那个令牌，能下载就等于能收
	 * 那部手机的短信。
	 */
	if (!params.id && c.req.method === 'PUT') {
		const tokenId = (c.req.query('key') ?? '').trim();
		if (!tokenId) return apiMessage(c, 400, '请选择要下载的令牌');
		const artifact = await firstSql<{ object_key: string }>(database, sql({ database }).select({
			table: 'sms_shortcut_artifacts',
			columns: { object_key: 'object_key' },
			where: [{ column: 'token_id', value: tokenId }, { column: 'status', value: 'ready' }],
			// 换发过的取最新那一版：旧版本在换发时被置为 revoked，上面的条件已经把它们挡在外面。
			orderBy: [{ column: 'version', direction: 'DESC' }], limit: 1,
		}));
		if (!artifact) return apiMessage(c, 404, '这个令牌还没有可下载的文件');
		const storage = await loadCloudStorageTargetByPurpose(c.get('globalDatabase'), c.get('site').siteKey, 'sms-shortcut');
		if (!storage) return apiMessage(c, 503, '没有为用途 sms-shortcut 配置对象存储绑定');
		try {
			return apiMessageData(c, 200, '下载地址创建成功', { downloadUrl: await createCloudStorageAdapter(storage).createDownloadUrl(String(artifact.object_key)), key: tokenId });
		} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : '下载地址创建失败'); }
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const row = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'id', value: params.id }],
		}));
		if (!row) return apiMessage(c, 404, '令牌不存在');
		if (!getChangedFields(body, ['revoke']).has('revoke') || body.revoke !== true) return apiMessage(c, 400, '这一页只能撤销令牌');
		if (row.status === 'revoked') return apiMessage(c, 409, '这个令牌已经撤销过了');
		// 带上原状态做条件：两个人同时撤同一条，只有一个会真的改到行。
		await runOperation(c, database, [sql({ database }).update('sms_shortcut_tokens', { status: 'revoked' }, [
			{ column: 'id', value: params.id }, { column: 'status', value: row.status },
		])]);
		return apiMessage(c, 200, '令牌已撤销');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的令牌');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_shortcut_tokens', { id })));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
