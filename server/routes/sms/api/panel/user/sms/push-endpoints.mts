import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import { pushTargetError } from '@server/modules/sms/push-target.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 我的推送地址：把收到的短信转发到自己的服务端。
 *
 * 每条推送都带 Ed25519 签名，接收方从 `/api/push-key` 取公钥验签（绑定文档 §4.9.2）——
 * 所以这里不需要填任何密钥，也没有对称密钥要分发、要轮换。
 *
 * **地址由用户自己填，因此必须做出站校验（SSRF）**：不加限制的话，推送就成了从服务器
 * 发起的任意请求，填一个云元数据地址就能把实例凭证当成短信推给自己。保存时校验一次，
 * 每次投递前还要按解析结果再判一次——DNS 记录可以在保存之后被改指到内网。
 */

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'integration_client_id', title: '所属项目', component: 'select' as const, nullable: true,
		placeholder: '不选就是不挂在任何项目下' },
	{ dataIndex: 'url', title: '推送地址', component: 'textbox' as const, placeholder: 'https://你的服务端/sms-hook',
		rules: [{ required: true, message: '请输入推送地址' }] },
	{ dataIndex: 'status', title: '状态', component: 'switch' as const, checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
	{ dataIndex: 'phone_id', title: '限定手机', component: 'select' as const, nullable: true, placeholder: '不选就是这个账号的全部手机' },
	{ dataIndex: 'last_success_at', title: '最近成功', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'last_error', title: '最近错误', emptyText: '无', ellipsis: true, form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_push_endpoints', rowKey: 'id' };

const listColumns = {
	id: { column: 'e.id', cast: 'text' as const }, created_at: 'e.created_at',
	integration_client_id: { column: 'e.integration_client_id', cast: 'text' as const }, client_title: 'c.title',
	url: 'e.url', status: 'e.status',
	phone_id: { column: 'e.phone_id', cast: 'text' as const }, phone_number: 'p.number',
	last_success_at: 'e.last_success_at', last_error: 'e.last_error',
} as const;
const listJoins = [
	{ type: 'LEFT' as const, table: 'sms_phones', alias: 'p', left: 'p.id', right: 'e.phone_id' },
	{ type: 'LEFT' as const, table: 'sms_integration_clients', alias: 'c', left: 'c.id', right: 'e.integration_client_id' },
];

const publicEndpoint = (row: Record<string, unknown>) => ({
	id: row.id, created_at: row.created_at,
	// 0 表示不属于任何项目——存 0 而不是 NULL 的理由见 prisma 里那一列的注释；
	// 发给前端时换回 null，下拉框才认得出「没选」。
	integration_client_id: String(row.integration_client_id ?? '0') === '0' ? null : String(row.integration_client_id),
	client_title: row.client_title ?? null,
	url: row.url, status: row.status,
	phone_id: row.phone_id ? String(row.phone_id) : null,
	phone_number: row.phone_number ?? null,
	last_success_at: Number(row.last_success_at ?? 0) || null,
	last_error: row.last_error || null,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	// 只看自己的。公共层的归属判定已经会收敛，这里再写一次是因为这一页的语义就是「我的」。
	const mine = (column = 'e.owner_uid') => ownerScope(column, currentUser.id);

	/** 「所属项目」的下拉只列自己注册的接入方。 */
	const clientOptions = async () => (await allSql<{ id: string; name: string; title: string }>(database, sql({ database }).select({
		table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' }, name: 'name', title: 'title' },
		where: [ownerScope('owner_uid', currentUser.id)], orderBy: [{ column: 'id' }],
	}))).map((row) => ({ value: String(row.id), text: `${row.title}（${row.name}）` }));

	/** 「限定手机」的下拉只列自己的手机——列别人的号码等于把号码泄露出去。 */
	const phoneOptions = async () => (await allSql<{ id: string; number: string; title: string }>(database, sql({ database }).select({
		table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, number: 'number', title: 'title' },
		where: [ownerScope('owner_uid', currentUser.id)], orderBy: [{ column: 'id' }],
	}))).map((row) => ({ value: String(row.id), text: row.title ? `${row.number}（${row.title}）` : String(row.number) }));

	if (c.req.method === 'GET' && !params.id) {
		const [rows, phones, clients] = await Promise.all([
			allSql<Record<string, unknown>>(database, sql({ database }).select({
				table: 'sms_push_endpoints', alias: 'e', columns: listColumns, joins: listJoins, where: [mine()],
				sort: tableSort(c), orderBy: [{ column: 'e.id', direction: 'DESC' }],
			})),
			phoneOptions(),
			clientOptions(),
		]);
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }],
				row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }],
			} },
			columns: columns.map((column) => column.dataIndex === 'phone_id' ? { ...column, options: phones }
				: column.dataIndex === 'integration_client_id' ? { ...column, options: clients } : column),
			dataSource: rows.map(publicEndpoint), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_push_endpoints', alias: 'e', columns: listColumns, joins: listJoins, where: [{ column: 'e.id', value: params.id }, mine()],
		}));
		return row ? apiResponse(c, 200, publicEndpoint(row)) : apiMessage(c, 404, '推送地址不存在');
	}

	/** 选中的项目必须是自己注册的：带别人的接入方 id，等于把短信推给别人的项目。 */
	const ownedClient = async (value: unknown) => {
		const clientId = String(value ?? '').trim();
		// 空与 '0' 都念作「不属于任何项目」，落库统一写 0（见 prisma 那一列的注释）。
		if (!clientId || clientId === '0') return { value: '0' };
		const row = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'id', value: clientId }, ownerScope('owner_uid', currentUser.id)], limit: 1,
		}));
		return row ? { value: String(row.id) } : { error: '选中的项目不存在，或者不属于你' };
	};

	/** 限定的手机必须是自己的：请求体里带别人的手机 id，等于订阅别人的短信。 */
	const ownedPhone = async (value: unknown) => {
		const phoneId = String(value ?? '').trim();
		if (!phoneId) return { value: null as string | null };
		const row = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'id', value: phoneId }, ownerScope('owner_uid', currentUser.id)], limit: 1,
		}));
		return row ? { value: String(row.id) } : { error: '选中的手机不存在，或者不属于你' };
	};

	if (!params.id && c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const url = String(body.url ?? '').trim();
		const urlError = pushTargetError(url);
		if (urlError) return apiMessage(c, 400, urlError);
		const phone = await ownedPhone(body.phone_id);
		if (phone.error) return apiMessage(c, 400, phone.error);
		const client = await ownedClient(body.integration_client_id);
		if (client.error) return apiMessage(c, 400, client.error);
		await runOperationSql(c, database, sql({ database }).insert('sms_push_endpoints', {
			url, status: String(body.status ?? statusValues.enabled), phone_id: phone.value, integration_client_id: client.value,
		}));
		return apiMessage(c, 201, '推送地址已添加。之后收到的短信会推送到这里，接收方用 /api/push-key 的公钥验签。');
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const current = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_push_endpoints', columns: { id: { column: 'id', cast: 'text' } }, where: [{ column: 'id', value: params.id }, ownerScope('owner_uid', currentUser.id)],
		}));
		if (!current) return apiMessage(c, 404, '推送地址不存在');
		const changed = getChangedFields(body, ['url', 'status', 'phone_id', 'integration_client_id']);
		const values: Record<string, unknown> = {};
		if (changed.has('url')) {
			const url = String(body.url ?? '').trim();
			const urlError = pushTargetError(url);
			if (urlError) return apiMessage(c, 400, urlError);
			values.url = url;
			// 换了地址就把上一条错误清掉：那句话说的是旧地址，留着只会让人以为新地址也坏了。
			values.last_error = '';
		}
		if (changed.has('status')) values.status = String(body.status ?? statusValues.enabled);
		if (changed.has('phone_id')) {
			const phone = await ownedPhone(body.phone_id);
			if (phone.error) return apiMessage(c, 400, phone.error);
			values.phone_id = phone.value;
		}
		if (changed.has('integration_client_id')) {
			const client = await ownedClient(body.integration_client_id);
			if (client.error) return apiMessage(c, 400, client.error);
			values.integration_client_id = client.value;
		}
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		await runOperation(c, database, [sql({ database }).update('sms_push_endpoints', values, [{ column: 'id', value: params.id }, ownerScope('owner_uid', currentUser.id)])]);
		return apiMessage(c, 200, '已保存');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的推送地址');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_push_endpoints', [{ column: 'id', value: id }, ownerScope('owner_uid', currentUser.id)])));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
