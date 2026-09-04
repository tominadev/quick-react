import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';

import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { firstSql, sql } from '@server/database/sql.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { credentialStatement, verifyCredential } from '@server/modules/base/credentials.mjs';
import { loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import type { AccountCenterLink } from '@shared/types/user.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const usernamePattern = /^[a-zA-Z0-9_.-]{3,64}$/;
/**
 * 昵称与用户名一样租户内唯一，但字符集宽得多：中文、字母、数字都行。
 * 挡掉的是控制字符与首尾空白——它们看不见，却能造出两个"看起来一样"的昵称。
 */
const nicknamePattern = /^[^\p{C}\s](?:[^\p{C}]*[^\p{C}\s])?$/u;
const maxNicknameLength = 32;

/** 只列出自己能改的三个字段；角色、状态、归属都不在这里。 */
const profileForm = (values: { username: string; nickname: string }): FormPageConfig => ({
	description: '修改本站账号的用户名、昵称与密码。改密码需要先验证当前密码。',
	submitLabel: '保存',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	initialValues: { ...values, currentPassword: '', newPassword: '' },
	fields: [
		{ name: 'username', label: '用户名', type: 'text', maxLength: 64, extra: '3 到 64 位，可用字母、数字、下划线、点与连字符。', rules: [{ required: true, message: '请输入用户名' }] },
		{ name: 'nickname', label: '昵称', type: 'text', maxLength: maxNicknameLength, extra: `显示名，与用户名一样在本站内唯一，但可以用中文；最长 ${maxNicknameLength} 个字符，留空表示不设置。` },
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
			? await firstSql<{ username: string; nickname: string | null }>(database, sql({ database }).select({ table: 'base_users', columns: { username: 'name', nickname: 'nickname' }, where: [{ column: 'id', value: currentUser.id }] }))
			: undefined;
		return apiResponse(c, 200, {
			user: currentUser,
			...(accounts ?? {}),
			...(row ? { formPage: profileForm({ username: row.username, nickname: row.nickname ?? '' }) } : {}),
		});
	}
	if (c.req.method === 'PUT') {
		if (!currentUser) return apiMessage(c, 401, '请先登录');
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const changed = getChangedFields(body, ['username', 'nickname', 'newPassword']);
		const values: Record<string, unknown> = {};
		if (changed.has('username')) {
			const username = String(body.username ?? '').trim();
			if (!usernamePattern.test(username)) return apiMessage(c, 400, '用户名至少 3 个合法字符');
			values.name = username;
		}
		if (changed.has('nickname')) {
			const nickname = String(body.nickname ?? '').trim();
			if (nickname.length > maxNicknameLength) return apiMessage(c, 400, `昵称最长 ${maxNicknameLength} 个字符`);
			if (nickname && !nicknamePattern.test(nickname)) return apiMessage(c, 400, '昵称不能包含控制字符');
			// 留空存 NULL 而不是空串：唯一索引里 NULL 互不相等，未设置昵称的用户才不会互相撞车。
			values.nickname = nickname || null;
		}
		const newPassword = String(body.newPassword ?? '');
		const changingPassword = changed.has('newPassword') && Boolean(newPassword);
		if (changingPassword) {
			// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
			if (!await verifyCredential(database, currentUser.id, String(body.currentPassword ?? ''))) return apiMessage(c, 403, '当前密码不正确');
			const error = passwordError(newPassword);
			if (error) return apiMessage(c, 400, error);
		}
		if (!Object.keys(values).length && !changingPassword) return apiMessage(c, 400, '没有可修改的字段');
		try {
			// 资料与凭证分表，一次操作里两条写入——operation_id 会把它们归到同一组。
			await runOperation(c, database, [
				...(Object.keys(values).length ? [sql({ database }).update('base_users', values, { id: currentUser.id })] : []),
				...(changingPassword ? [await credentialStatement(database, currentUser.id, newPassword)] : []),
			]);
		} catch { return apiMessage(c, 409, '用户名或昵称已被占用'); }
		return apiMessageData(c, 200, '已保存', {}, { component: 'inline', showIcon: true, title: '保存结果' });
	}
	return next();
};

export default handler;
