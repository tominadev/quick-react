import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';

import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { firstSql, sql, type SqlQuery } from '@server/database/sql.mjs';
import { maxNicknameLength, profileStatement } from '@server/modules/base/profile.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { credentialStatement, verifyCredential } from '@server/modules/base/credentials.mjs';
import { loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import type { AccountCenterLink } from '@shared/types/user.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const usernamePattern = /^[a-zA-Z0-9_.-]{3,64}$/;

/** 只列出自己能改的三个字段；角色、状态、归属都不在这里。 */
const profileForm = (values: { username: string; nickname: string; qq: string; wechat: string; email: string }): FormPageConfig => ({
	description: '修改本站账号的用户名、昵称与密码。改密码需要先验证当前密码。',
	submitLabel: '保存',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	initialValues: { ...values, currentPassword: '', newPassword: '' },
	fields: [
		{ name: 'username', label: '用户名', type: 'text', maxLength: 64, extra: '3 到 64 位，可用字母、数字、下划线、点与连字符。', rules: [{ required: true, message: '请输入用户名' }] },
		{ name: 'nickname', label: '昵称', type: 'text', maxLength: maxNicknameLength, extra: `显示名，与用户名一样在本站内唯一，但可以用中文；最长 ${maxNicknameLength} 个字符，留空则显示用户名。` },
		{ name: 'qq', label: 'QQ', type: 'text', maxLength: 20 },
		{ name: 'wechat', label: '微信号', type: 'text', maxLength: 64 },
		{ name: 'email', label: '联系邮箱', type: 'text', maxLength: 254, extra: '本站不做验证，仅作联系方式。' },
		{ name: 'currentPassword', label: '当前密码', type: 'password', extra: '只有在设置新密码时才需要填写。' },
		{ name: 'newPassword', label: '新密码', type: 'password', extra: '留空表示不修改密码。' },
	],
});

/**
 * 个人中心：展示当前登录身份，并允许改自己的用户名、昵称与密码。
 *
 * 只能改**自己**这一行——用的是会话里的 currentUser.id，请求体里带别人的 ID 也没用。
 * 账号中心入口始终在新页面打开：业务站点不会把当前页面带去其它域名。
 */
const handler: ApiHandler = async (c, next) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (c.req.method === 'GET') {
		const config = await loadAccountsOidcConfig(c);
		let issuer: URL | undefined;
		if (config.enabled && config.issuer) {
			try { issuer = new URL(config.issuer); }
			catch { issuer = undefined; }
		}
		const accounts: { accountsNotice: string; accountsCenter: AccountCenterLink } | undefined = issuer
			? {
				accountsNotice: `本站账号与 Accounts 账号中心（${issuer.host}）各自独立：这里改的是本站账号。点击下面的按钮会在新页面打开账号中心，当前页面不会离开。`,
				accountsCenter: { label: '在新页面打开账号中心', url: `${issuer.origin}/panel/accounts` },
			}
			: undefined;
		const row = currentUser
			? await firstSql<{ username: string; nickname: string | null; qq: string | null; wechat: string | null; email: string | null }>(database, sql({ database }).select({
				table: 'base_users', alias: 'u', columns: { username: 'u.name', nickname: 'p.nickname', qq: 'p.qq', wechat: 'p.wechat', email: 'p.email' },
				joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }],
				where: [{ column: 'u.id', value: currentUser.id }],
			}))
			: undefined;
		return apiResponse(c, 200, {
			user: currentUser,
			...(accounts ?? {}),
			...(row ? { formPage: profileForm({ username: row.username, nickname: row.nickname ?? '', qq: row.qq ?? '', wechat: row.wechat ?? '', email: row.email ?? '' }) } : {}),
		});
	}
	if (c.req.method === 'PUT') {
		if (!currentUser) return apiMessage(c, 401, '请先登录');
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const changed = getChangedFields(body, ['username', 'nickname', 'qq', 'wechat', 'email', 'newPassword']);
		const values: Record<string, unknown> = {};
		if (changed.has('username')) {
			const username = String(body.username ?? '').trim();
			if (!usernamePattern.test(username)) return apiMessage(c, 400, '用户名至少 3 个合法字符');
			values.name = username;
		}
		let profileWrite: SqlQuery | undefined;
		const profileChanges = Object.fromEntries((['nickname', 'qq', 'wechat', 'email'] as const)
			.filter((name) => changed.has(name))
			.map((name) => [name, String(body[name] ?? '')]));
		if (Object.keys(profileChanges).length) {
			const tenantId = c.get('tenantId');
			const scope = tenantId === null ? { column: 'owner_tid', operator: 'IS NULL' as const } : { column: 'owner_tid', value: tenantId };
			const result = await profileStatement(database, currentUser.id, profileChanges, scope);
			if ('error' in result) return apiMessage(c, 400, result.error);
			profileWrite = 'statement' in result ? result.statement : result.clear;
		}
		const newPassword = String(body.newPassword ?? '');
		const changingPassword = changed.has('newPassword') && Boolean(newPassword);
		if (changingPassword) {
			// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
			if (!await verifyCredential(database, currentUser.id, String(body.currentPassword ?? ''))) return apiMessage(c, 403, '当前密码不正确');
			const error = passwordError(newPassword);
			if (error) return apiMessage(c, 400, error);
		}
		if (!Object.keys(values).length && !changingPassword && !profileWrite) return apiMessage(c, 400, '没有可修改的字段');
		try {
			// 资料与凭证分表，一次操作里两条写入——operation_id 会把它们归到同一组。
			await runOperation(c, database, [
				...(Object.keys(values).length ? [sql({ database }).update('base_users', values, { id: currentUser.id })] : []),
				...(changingPassword ? [await credentialStatement(database, currentUser.id, newPassword)] : []),
				...(profileWrite ? [profileWrite] : []),
			]);
		} catch { return apiMessage(c, 409, '用户名或昵称已被占用'); }
		return apiMessageData(c, 200, '已保存', {}, { component: 'inline', showIcon: true, title: '保存结果' });
	}
	return next();
};

export default handler;
