import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { allSql, sql } from '@server/database/sql.mjs';
import { passportProfileNicknameOf } from '@server/modules/passport/profile.mjs';
import { passportPasswordStatement } from '@server/modules/passport/identity.mjs';
import { runOperationSql } from '@server/modules/base/operation.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

export const tableCrud: TableCrudDefinition = { table: 'passport_users', rowKey: 'key', database: 'passportDatabase' };

const columns = [
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'updated_at', title: '更新时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'user_key', title: 'ID', dataType: 'text' as const },
	{ dataIndex: 'user_name', title: '用户名' },
	{ dataIndex: 'profile_nickname', title: '昵称' },
	{ dataIndex: 'password', title: '密码特征' },
	{ dataIndex: 'status', title: '状态' }];
const passwordResetColumns = [{ dataIndex: 'password', title: '新密码', component: 'textbox' as const, inputType: 'password' as const, placeholder: '至少 8 个字符', rules: [{ required: true, message: '请输入新密码' }] }];

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('passportDatabase');
	if (!database) return apiMessage(c, 503, 'Accounts 数据库不可用');
	if (params.id && c.req.method === 'POST' && c.req.query('action') === 'reset-password') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		// 管理员改别人的密码：留痕，且 admin 作用域会进审批队列。
		try { await runOperationSql(c, database, await passportPasswordStatement(database, params.id, String(body.password ?? ''))); }
		catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '密码设置失败'); }
		return apiMessage(c, 200, '密码已重设');
	}
	if (c.req.method !== 'GET') return next();
	const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'passport_users', alias: 'u', columns: { user_key: { column: 'u.key', cast: 'text' }, user_name: 'u.name', profile_nickname: 'p.nickname', status: 'u.status', created_at: 'u.created_at', updated_at: 'u.updated_at' }, joins: [{ type: 'LEFT', table: 'passport_user_profiles', alias: 'p', left: 'p.user_key', right: 'u.key' }], sort: tableSort(c), orderBy: [{ column: 'u.created_at', direction: 'DESC' }] }));
	const credentials = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'passport_user_credentials', columns: { user_key: { column: 'user_key', cast: 'text' }, password: 'password', created_at: 'created_at' }, orderBy: [{ column: 'created_at', direction: 'DESC' }] }));
	const patterns = new Map<string, string>();
	for (const credential of credentials) {
		const userId = String(credential.user_key ?? '');
		if (!patterns.has(userId)) patterns.set(userId, readStoredPassword(credential.password)?.pattern ?? '');
	}
	// 没设过资料就回落到用户名。
	const dataSource = rows.map((row) => ({ ...row, profile_nickname: passportProfileNicknameOf(String(row.user_name ?? ''), row.profile_nickname as string | null), password: patterns.get(String(row.user_key)) ?? '' }));
	return apiResponse(c, 200, { table: { option: { rowKey: 'user_key', actions: { row: [{ key: 'reset-password', label: '重设密码', form: { columns: passwordResetColumns } }] } }, columns, dataSource, totalRecords: dataSource.length } });
};

export const acceptsTrailingParams = true;
export default handler;
