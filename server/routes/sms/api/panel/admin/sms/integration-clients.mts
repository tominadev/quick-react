import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 接入方：可以代表用户签发绑定票据的服务端。
 *
 * 用户在别处的系统里点「绑定手机」，那个系统用自己的 Ed25519 私钥签一张票据，SMS 验签后
 * 才认这次绑定（绑定文档 §6）。这一页登记的是「谁有资格签」。
 *
 * **公钥不在这一页。** 轮换期间新旧公钥要并存，一行放不下，因此拆在
 * `sms_integration_client_keys`（按 `kid` 定位）。那一页随 `/api/client/` 那条链一起做——
 * 没有验签入口时，先登记公钥没有用处。
 */

/** 本期只有一种能力。做成选项而不是写死，是因为它已经是协议字段，将来多一种时这里不必改结构。 */
const SCOPE_OPTIONS = [{ value: 'phone:bind', text: '绑定手机', color: 'blue' }];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'name', title: '接入方标识', component: 'textbox' as const, maxLength: 64,
		placeholder: '票据里的 client_id',
		rules: [{ required: true, message: '请输入接入方标识' }] },
	{ dataIndex: 'title', title: '名称', component: 'textbox' as const, placeholder: '给人看的名字',
		rules: [{ required: true, message: '请输入名称' }] },
	{ dataIndex: 'binding_scope', title: '允许的能力', component: 'select' as const, options: SCOPE_OPTIONS, multiple: true },
	{ dataIndex: 'status', title: '状态', component: 'switch' as const, checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
	{ dataIndex: 'last_used_at', title: '最近验签', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_integration_clients', rowKey: 'id' };

const listColumns = {
	id: { column: 'id', cast: 'text' as const }, name: 'name', title: 'title',
	binding_scope: 'binding_scope', status: 'status', last_used_at: 'last_used_at', created_at: 'created_at',
} as const;

/** 能力存成逗号分隔的一串，读回来给前端的多选控件。 */
const parseScope = (value: unknown) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const serializeScope = (value: unknown) => {
	const list = Array.isArray(value) ? value.map((item) => String(item)) : parseScope(value);
	const allowed = list.filter((item) => SCOPE_OPTIONS.some((option) => option.value === item));
	return { value: allowed.join(','), unknown: list.filter((item) => !allowed.includes(item)) };
};

const publicClient = (row: Record<string, unknown>) => ({
	id: row.id, name: row.name, title: row.title,
	binding_scope: parseScope(row.binding_scope),
	status: row.status,
	last_used_at: Number(row.last_used_at ?? 0) || null,
	created_at: row.created_at,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const tenantScope = () => ownerScope('owner_tid', c.get('tenantId'));

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: listColumns,
			sort: tableSort(c), orderBy: [{ column: 'id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }],
				row: [
					// 公钥在另一张表上（轮换要新旧并存），带上 integration_client_id 打开，
					// 不带的话弹开的是全站的公钥。
					{ key: 'keys', label: '公钥', modalPath: '/panel/admin/sms/client-keys', modalComponent: 'table' as const, modalQueryFields: { integration_client_id: 'id' } },
					{ key: 'edit', label: '编辑' },
					{ key: 'delete', label: '删除' },
				],
			} },
			columns, dataSource: rows.map(publicClient), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: listColumns, where: [{ column: 'id', value: params.id }],
		}));
		return row ? apiResponse(c, 200, publicClient(row)) : apiMessage(c, 404, '接入方不存在');
	}

	if (!params.id && c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const name = String(body.name ?? '').trim();
		const title = String(body.title ?? '').trim();
		if (!name) return apiMessage(c, 400, '请输入接入方标识');
		if (!title) return apiMessage(c, 400, '请输入名称');
		const scope = serializeScope(body.binding_scope);
		if (scope.unknown.length) return apiMessage(c, 400, `不支持的能力：${scope.unknown.join('、')}`);
		if (!scope.value) return apiMessage(c, 400, '请至少选择一项能力');
		// 重名先挡（理由同 machines.mts）：进了队列才撞唯一索引的话，那条申请谁也批不动。
		const taken = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'name', value: name }, tenantScope()], queued: 'all', limit: 1,
		}));
		if (taken) return apiMessage(c, 409, '接入方标识已存在');
		try {
			await runOperationSql(c, database, sql({ database }).insert('sms_integration_clients', {
				name, title, binding_scope: scope.value, status: String(body.status ?? statusValues.enabled),
			}));
			return apiMessage(c, 201, '接入方已登记。公钥要等 /api/client/ 那条链做好后再登记，在此之前它签的票据一律验不过');
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '接入方标识已存在');
		}
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const current = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' } }, where: [{ column: 'id', value: params.id }],
		}));
		if (!current) return apiMessage(c, 404, '接入方不存在');
		const changed = getChangedFields(body, ['name', 'title', 'binding_scope', 'status']);
		const values: Record<string, unknown> = {};
		if (changed.has('name')) {
			const name = String(body.name ?? '').trim();
			if (!name) return apiMessage(c, 400, '请输入接入方标识');
			values.name = name;
		}
		if (changed.has('title')) {
			const title = String(body.title ?? '').trim();
			if (!title) return apiMessage(c, 400, '请输入名称');
			values.title = title;
		}
		if (changed.has('binding_scope')) {
			const scope = serializeScope(body.binding_scope);
			if (scope.unknown.length) return apiMessage(c, 400, `不支持的能力：${scope.unknown.join('、')}`);
			if (!scope.value) return apiMessage(c, 400, '请至少选择一项能力');
			values.binding_scope = scope.value;
		}
		if (changed.has('status')) values.status = String(body.status ?? statusValues.enabled);
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		try {
			await runOperation(c, database, [sql({ database }).update('sms_integration_clients', values, { id: params.id })]);
			return apiMessage(c, 200, '接入方已保存');
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '接入方标识已存在');
		}
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的接入方');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_integration_clients', { id })));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
