import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';

import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { firstSql, sql, type SqlQuery } from '@server/database/sql.mjs';
import { profileStatement } from '@server/modules/base/profile.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { credentialStatement, verifyCredential } from '@server/modules/base/credentials.mjs';
import { loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import type { AccountCenterLink } from '@shared/types/user.mjs';
import { maxNicknameWidth, maxUserNameLength, minNicknameWidth, userNameError } from '@shared/account-name.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';


/** 只列出自己能改的三个字段；角色、状态、归属都不在这里。 */
const profileForm = (values: { user_name: string; profile_nickname: string; profile_qq: string; profile_wechat: string; profile_email: string }): FormPageConfig => ({
	description: '修改本站账号的用户名、昵称与密码。改密码需要先验证当前密码。',
	submitLabel: '保存',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	initialValues: { ...values, currentPassword: '', newPassword: '' },
	fields: [
		{ name: 'user_name', label: '用户名', type: 'text', maxLength: maxUserNameLength, extra: `以小写字母开头，只能包含小写字母和数字，最长 ${maxUserNameLength} 位。`, rules: [{ required: true, message: '请输入用户名' }] },
		{ name: 'profile_nickname', label: '昵称', type: 'text', maxLength: maxNicknameWidth, extra: `显示名，与用户名一样在本站内唯一，但可以用各国语言；宽度 ${minNicknameWidth} 到 ${maxNicknameWidth} 个半角字符（一个全角按两个半角计），留空则显示用户名。` },
		{ name: 'profile_qq', label: 'QQ', type: 'text', maxLength: 20 },
		{ name: 'profile_wechat', label: '微信号', type: 'text', maxLength: 64 },
		{ name: 'profile_email', label: '联系邮箱', type: 'text', maxLength: 254, extra: '本站不做验证，仅作联系方式。' },
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
			? await firstSql<{ user_name: string; profile_nickname: string | null; profile_qq: string | null; profile_wechat: string | null; profile_email: string | null }>(database, sql({ database }).select({
				table: 'base_users', alias: 'u', columns: { user_name: 'u.name', profile_nickname: 'p.nickname', profile_qq: 'p.qq', profile_wechat: 'p.wechat', profile_email: 'p.email' },
				joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }],
				where: [{ column: 'u.id', value: currentUser.id }],
			}))
			: undefined;
		return apiResponse(c, 200, {
			user: currentUser,
			...(accounts ?? {}),
			...(row ? { formPage: profileForm({ user_name: row.user_name, profile_nickname: row.profile_nickname ?? '', profile_qq: row.profile_qq ?? '', profile_wechat: row.profile_wechat ?? '', profile_email: row.profile_email ?? '' }) } : {}),
		});
	}
	if (c.req.method === 'PUT') {
		if (!currentUser) return apiMessage(c, 401, '请先登录');
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const changed = getChangedFields(body, ['user_name', 'profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email', 'newPassword']);
		const values: Record<string, unknown> = {};
		if (changed.has('user_name')) {
			const userName = String(body.user_name ?? '').trim();
			const error = userNameError(userName, c.get('siteSettings').userNameMinLength);
			if (error) return apiMessage(c, 400, error);
			values.name = userName;
		}
		let profileWrite: SqlQuery | undefined;
		const profileChanges = Object.fromEntries((['profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email'] as const)
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
