import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { createStoredPassword, readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { allSql, firstSql, runSql, runSystemSql, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperationSql } from '@server/modules/base/operation.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import { assignableRoleOptions, parseRoles, serializeRoles, unknownAssignableRoles } from '@shared/types/role.mjs';
import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'username', title: '用户名', component: 'textbox' as const },
	{ dataIndex: 'password', title: '新密码', component: 'textbox' as const, inputType: 'password' as const, placeholder: '留空表示不修改', form: { create: { title: '密码', placeholder: '至少 8 个字符', rules: [{ required: true, message: '请输入密码' }] } } },
	{ dataIndex: 'roles', title: '角色', component: 'select' as const, multiple: true, options: assignableRoleOptions, placeholder: '留空表示仅具备登录用户权限' },
	{ dataIndex: 'status', title: '状态', component: 'switch' as const, checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'updated_at', title: '更新时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
];

export const tableCrud: TableCrudDefinition = { table: 'base_users', rowKey: 'id' };

const publicUser = (row: Record<string, unknown>) => ({
	id: row.id,
	username: row.username,
	password: readStoredPassword(row.password)?.pattern ?? '',
	roles: parseRoles(row.roles),
	status: row.status,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	// 用户名只在租户内唯一，按名查找一律限本租户；列表与按 id 读取待行级判定落地后由公共层收敛。
	const tenantId = c.get('tenantId');
	const tenantScope = (column = 'owner_tid') => tenantId === null ? { column, operator: 'IS NULL' as const } : { column, value: tenantId };
	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id', username: 'name', roles: 'roles', status: 'status', password: 'password', created_at: 'created_at', updated_at: 'updated_at' }, orderBy: [{ column: 'id', direction: 'DESC' }] }));
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }], row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }] } }, columns, dataSource: rows.map(publicUser), totalRecords: rows.length } });
	}
	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id', username: 'name', roles: 'roles', status: 'status', password: 'password', created_at: 'created_at', updated_at: 'updated_at' }, where: [{ column: 'id', value: params.id }] }));
		return row ? apiResponse(c, 200, publicUser(row)) : apiMessage(c, 404, '用户不存在');
	}
	if (!params.id && c.req.method === 'POST') {
		const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const username = String(body.username ?? '').trim();
		const password = String(body.password ?? '');
		if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username) || passwordError(password)) return apiMessage(c, 400, '用户名至少 3 个合法字符，密码至少需要 8 个字符');
		const roles = parseRoles(body.roles);
		const unknownRoles = unknownAssignableRoles(roles);
		if (unknownRoles.length) return apiMessage(c, 400, `不支持的角色：${unknownRoles.join('、')}`);
		try {
			await runSql(database, sql({ database }).insert('base_users', { name: username, password: await createStoredPassword(password), roles: serializeRoles(roles), status: String(body.status ?? 'enabled') }));
			const created = await firstSql<{ id: number | string }>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: username }, tenantScope()] }));
			// 账号行归属账号自己，不归创建它的管理员。这是新建流程的收尾动作，不是人做的
			// 修改——新增本就不留痕（§3.2），单独给这一步记一条只会是噪音。
			if (created) await runSystemSql(database, sql({ database }).update('base_users', { owner_uid: created.id }, { id: created.id }));
			return apiMessageData(c, 201, '用户已创建', { id: created?.id, username });
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			return apiMessage(c, 409, '用户名已存在');
		}
	}
	if (params.id && c.req.method === 'PUT') {
		const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const current = await firstSql<{ id: number }>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'id', value: params.id }] }));
		if (!current) return apiMessage(c, 404, '用户不存在');
		const changedFields = getChangedFields(body, ['username', 'roles', 'status', 'password']);
		const values: Record<string, unknown> = {};
		for (const key of ['username', 'status']) {
			if (changedFields.has(key)) values[key === 'username' ? 'name' : key] = String(body[key] ?? '');
		}
		if (changedFields.has('roles')) {
			const roles = parseRoles(body.roles);
			const unknownRoles = unknownAssignableRoles(roles);
			if (unknownRoles.length) return apiMessage(c, 400, `不支持的角色：${unknownRoles.join('、')}`);
			values.roles = serializeRoles(roles);
		}
		const password = String(body.password ?? '');
		if (changedFields.has('password') && password) {
			const error = passwordError(password);
			if (error) return apiMessage(c, 400, error);
			values.password = await createStoredPassword(password);
		}
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		try {
			await runOperationSql(c, database, sql({ database }).update('base_users', values, { id: params.id }));
			return apiMessage(c, 200, '用户已保存');
		} catch (error) { if (error instanceof PendingApprovalError) throw error; return apiMessage(c, 409, '用户名已存在'); }
	}
	// 界面上的删除（单条与批量）一律发到集合地址、id 放在请求体里，两种形态都要接。
	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的用户');
		for (const id of ids) await runOperationSql(c, database, sql({ database }).softDelete('base_users', { id }));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
