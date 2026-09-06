import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { createStoredPassword, readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { allSql, firstSql, isUniqueViolation, runSql, runSystemSql, sql, type SqlQuery, ownerScope } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { finishUserCreation } from '@server/modules/base/registration.mjs';
import { credentialStatement, setCredential } from '@server/modules/base/credentials.mjs';
import { profileStatement } from '@server/modules/base/profile.mjs';
import { userNameError } from '@shared/account-name.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import { assignableRoleOptions, parseRoles, serializeRoles, unknownAssignableRoles } from '@shared/types/role.mjs';
import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const, group: '基础设置' },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', group: '基础设置' },
	{ dataIndex: 'updated_at', title: '更新时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', group: '基础设置' },
	{ dataIndex: 'user_name', title: '用户名', component: 'textbox' as const, group: '基础设置' },
	{ dataIndex: 'password', title: '新密码', component: 'textbox' as const, inputType: 'password' as const, emptyText: '未设置', placeholder: '留空表示不修改', form: { create: { title: '密码', placeholder: '至少 8 个字符', rules: [{ required: true, message: '请输入密码' }] } } },
	{ dataIndex: 'roles', title: '角色', component: 'select' as const, multiple: true, options: assignableRoleOptions, placeholder: '留空表示仅具备登录用户权限' },
	{ dataIndex: 'status', title: '状态', component: 'switch' as const, checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
	// 个人简介都存在 base_user_profiles：没有资料行就是没设过，昵称回落到用户名。
	{ dataIndex: 'profile_nickname', title: '昵称', component: 'textbox' as const, nullable: true, fallbackField: 'user_name', placeholder: '默认与用户名相同', group: '个人简介' },
	// 三列都可能没填。空格子看不出是「没填」还是「显示坏了」，写明白。
	{ dataIndex: 'profile_qq', title: 'QQ', component: 'textbox' as const, nullable: true, emptyText: '未填写', group: '个人简介' },
	{ dataIndex: 'profile_wechat', title: '微信号', component: 'textbox' as const, nullable: true, emptyText: '未填写', group: '个人简介' },
	{ dataIndex: 'profile_email', title: '联系邮箱', component: 'textbox' as const, nullable: true, emptyText: '未填写', placeholder: '本站不做验证，仅作联系方式', group: '个人简介' }];

export const tableCrud: TableCrudDefinition = { table: 'base_users', rowKey: 'id' };

// 列表选出来的列：既是查询的列，也是「哪些列可以排序」的白名单，两者不会走偏。
const listColumns = {
	id: 'u.id', user_name: 'u.name', profile_nickname: 'p.nickname',
	profile_qq: 'p.qq', profile_wechat: 'p.wechat', profile_email: 'p.email',
	roles: 'u.roles', status: 'u.status', password: 'c.password',
	created_at: 'u.created_at', updated_at: 'u.updated_at',
} as const;
const listJoins = [
	{ type: 'LEFT' as const, table: 'base_user_credentials', alias: 'c', left: 'c.user_id', right: 'u.id' },
	{ type: 'LEFT' as const, table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' },
];

/** 个人简介字段统一从请求体里取；传了 changedFields 就只取这次真正改过的。 */
const profileFieldsFrom = (body: Record<string, unknown>, changed?: Set<string>) => Object.fromEntries(
	(['profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email'] as const)
		.filter((name) => !changed || changed.has(name))
		.map((name) => [name, String(body[name] ?? '')]),
);

const publicUser = (row: Record<string, unknown>) => ({
	id: row.id,
	user_name: row.user_name,
	// 发真值：没设过昵称就是 null。列表上回落到用户名由列上的 fallbackField 声明——
	// 在这里回落的话，编辑表单拿到的是用户名而不是真值，「不设昵称」就只能靠
	// 「把它改回用户名」这种没人猜得到的操作来表达。
	profile_nickname: row.profile_nickname ?? null,
	// 没值就发 null，不折成空串：接口说真话，「没填」怎么显示由列上的 emptyText 声明。
	// 表单那一侧的归一在 drawer 里按控件做——受控输入吃不下 null，但那是它的事，不是这里的。
	profile_qq: row.profile_qq ?? null,
	profile_wechat: row.profile_wechat ?? null,
	profile_email: row.profile_email ?? null,
	// 没有凭证行就是没设过本站密码（只能用 Accounts 登录），与「设了一个空密码」不是一回事。
	password: readStoredPassword(row.password)?.pattern ?? null,
	roles: parseRoles(row.roles),
	status: row.status,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	// 用户名只在租户内唯一，按名查找一律限本租户；列表与按 id 读取待行级判定落地后由公共层收敛。
	const tenantId = c.get('tenantId');
	const tenantScope = (column = 'owner_tid') => ownerScope(column, tenantId);
	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'base_users', alias: 'u', columns: listColumns, joins: listJoins, sort: tableSort(c), orderBy: [{ column: 'u.id', direction: 'DESC' }] }));
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }], row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }] } }, columns, dataSource: rows.map(publicUser), totalRecords: rows.length } });
	}
	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'base_users', alias: 'u', columns: listColumns, joins: listJoins, where: [{ column: 'u.id', value: params.id }] }));
		return row ? apiResponse(c, 200, publicUser(row)) : apiMessage(c, 404, '用户不存在');
	}
	if (!params.id && c.req.method === 'POST') {
		const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const userName = String(body.user_name ?? '').trim();
		const password = String(body.password ?? '');
		const nameError = userNameError(userName, c.get('siteSettings').userNameMinLength);
		if (nameError) return apiMessage(c, 400, nameError);
		if (passwordError(password)) return apiMessage(c, 400, '密码至少需要 8 个字符');
		const roles = parseRoles(body.roles);
		const unknownRoles = unknownAssignableRoles(roles);
		if (unknownRoles.length) return apiMessage(c, 400, `不支持的角色：${unknownRoles.join('、')}`);
		/**
		 * 重名要在**记录之前**挡掉。
		 *
		 * 审批是「先记录后应用」（§6.2），所以等 INSERT 撞上唯一索引才失败的话，队列里已经
		 * 留下一条申请，而它指向的那一行从来没写成——批也批不动，界面上却像是有人在等审批。
		 *
		 * 条件要和唯一索引 `(owner_tid, name, deleted_at)` 一字不差：只看未删除的行（回收站里
		 * 的同名账号不占名字），并且 `pended: 'all'` 把**还在审批队列里的新账号**算进来——
		 * 它已经把那个名字占住了。系统上下文是必须的：分站管理员的可见性是 owner_bid，
		 * 查不到本租户里别的分站的同名账号，那道检查会漏，然后照样撞索引。
		 */
		const taken = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'base_users',
			columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'name', value: userName }, tenantScope()],
			pended: 'all',
			limit: 1,
		}));
		if (taken) return apiMessage(c, 409, '用户名已存在');
		try {
			/**
			 * 建号要写三行：账号、凭证、资料（资料只有填了才写）。三行共享一个操作号，
			 * 批准或驳回时一起处理——只批账号那一行，得到的是「能登录但没有密码」；
			 * 只驳回账号那一行，凭证和资料就成了指向不存在账号的垃圾。
			 *
			 * 后两行的 user_id 要等账号行插进去才知道，一次 runOperation 传不完，
			 * 因此用 defer 让它排队但不抛异常，三步都走完再由这里收尾。
			 */
			const operationId = crypto.randomUUID();
			const queued = { operationId, defer: true } as const;
			await runOperationSql(c, database, sql({ database }).insert('base_users', { name: userName, roles: serializeRoles(roles), status: String(body.status ?? 'enabled') }), queued);
			// 收尾：把行归属给账号自己。这是创建的一部分，不是人做的修改，因此不另记一条。
			const createdId = await finishUserCreation(database, userName, tenantId);
			if (createdId !== undefined) {
				// 新账号必定没有凭证行，因此这里是纯 insert 而不是 upsert——upsert 冲突时
				// 走的是 UPDATE，操作层不会把它记成新建。
				await runOperationSql(c, database, sql({ database }).insert('base_user_credentials', { user_id: createdId, password: await createStoredPassword(password) }), queued);
				const profile = profileFieldsFrom(body);
				if (Object.values(profile).some(Boolean)) {
					const result = await profileStatement(database, createdId, profile, tenantScope(), { create: true });
					if ('error' in result) return apiMessage(c, 400, result.error);
					if ('statement' in result) await runOperationSql(c, database, result.statement, queued);
				}
			}
			const pending = c.get('pendingApproval');
			if (pending?.operationId === operationId) throw new PendingApprovalError(pending.operationId, pending.entries);
			return apiMessageData(c, 201, '用户已创建', { id: createdId, user_name: userName });
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			// 上面已经先查过重名，走到这里的多半是凭证或资料那两行撞了唯一索引（昵称被占）。
			// 只认唯一索引冲突：把别的故障也说成「已存在」，会让真正的问题查不出来。
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '用户名或昵称已被占用');
		}
	}
	if (params.id && c.req.method === 'PUT') {
		const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const current = await firstSql<{ id: number }>(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'id', value: params.id }] }));
		if (!current) return apiMessage(c, 404, '用户不存在');
		const changedFields = getChangedFields(body, ['user_name', 'profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email', 'roles', 'status', 'password']);
		const values: Record<string, unknown> = {};
		for (const key of ['user_name', 'status']) {
			if (changedFields.has(key)) values[key === 'user_name' ? 'name' : key] = String(body[key] ?? '');
		}

		if (changedFields.has('roles')) {
			const roles = parseRoles(body.roles);
			const unknownRoles = unknownAssignableRoles(roles);
			if (unknownRoles.length) return apiMessage(c, 400, `不支持的角色：${unknownRoles.join('、')}`);
			values.roles = serializeRoles(roles);
		}
		const password = String(body.password ?? '');
		const changingPassword = changedFields.has('password') && Boolean(password);
		if (changingPassword) {
			const error = passwordError(password);
			if (error) return apiMessage(c, 400, error);
		}
		let profileWrite: SqlQuery | undefined;
		const profileChanges = profileFieldsFrom(body, changedFields);
		if (Object.keys(profileChanges).length) {
			const result = await profileStatement(database, params.id, profileChanges, tenantScope());
			if ('error' in result) return apiMessage(c, 400, result.error);
			profileWrite = 'statement' in result ? result.statement : result.clear;
		}
		if (!Object.keys(values).length && !changingPassword && !profileWrite) return apiMessage(c, 400, '没有可修改的字段');
		try {
			// 资料与凭证分表，一次操作里两条写入——operation_id 会把它们归到同一组。
			const statements = [
				...(Object.keys(values).length ? [sql({ database }).update('base_users', values, { id: params.id })] : []),
				...(changingPassword ? [await credentialStatement(database, params.id, password)] : []),
				...(profileWrite ? [profileWrite] : []),
			];
			// 账号那一行是这条记录的身份：别人挂在它上面的申请要拦住这里的每一种修改，
			// 哪怕这次只动了资料表（见 OperationOptions.lockRows）。
			await runOperation(c, database, statements, { lockRows: [{ table: 'base_users', rowId: params.id }] });
			return apiMessage(c, 200, '用户已保存');
		} catch (error) { if (error instanceof PendingApprovalError) throw error; if (!isUniqueViolation(error)) throw error; return apiMessage(c, 409, '用户名或昵称已被占用'); }
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
