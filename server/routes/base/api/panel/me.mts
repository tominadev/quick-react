import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';

import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { firstSql, sql, ownerScope } from '@server/database/sql.mjs';
import { profileNicknameOf, profileStatement } from '@server/modules/base/profile.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { credentialStatement, hasCredential, verifyCredential } from '@server/modules/base/credentials.mjs';
import { loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import { maxNicknameWidth, maxUserNameLength, minNicknameWidth, userNameError } from '@shared/account-name.mjs';
import type { AccountCenterLink } from '@shared/types/user.mjs';
import { SECTION_FIELD, type FormPageConfig } from '@shared/types/form-page.mjs';

type ProfileRow = { user_name: string; profile_nickname: string | null; profile_qq: string | null; profile_wechat: string | null; profile_email: string | null };

/**
 * 个人中心的三组设置。分成选项卡而不是一张长表单：它们互不相干，一次只改一组，
 * 而且各有各的失败方式——用户名撞名、昵称撞名、当前密码不对。混在一起提交的话，
 * 一处失败会让另外两处也白填。
 */
const profileForm = (values: ProfileRow, hasPassword: boolean): FormPageConfig => ({
	description: '修改本站账号的资料。本站账号与 Accounts 账号各自独立，这里改的只是本站的。',
	sectionLayout: 'tabs',
	initialValues: {
		user_name: values.user_name,
		// 昵称没设过时回落显示用户名，表单里因此不是空白；原样提交回来当作没设。
		profile_nickname: profileNicknameOf(values.user_name, values.profile_nickname),
		profile_qq: values.profile_qq ?? '', profile_wechat: values.profile_wechat ?? '', profile_email: values.profile_email ?? '',
		currentPassword: '', newPassword: '',
	},
	sections: [
		{
			key: 'user_name', title: '用户名', submitLabel: '保存用户名',
			description: '用户名是登录用的标识，本站内唯一。改掉之后要用新用户名登录。',
			fields: [{ name: 'user_name', label: '用户名', maxLength: maxUserNameLength, extra: `以小写字母开头，只能包含小写字母和数字，最长 ${maxUserNameLength} 位。`, rules: [{ required: true, message: '请输入用户名' }] }],
		},
		{
			key: 'profile', title: '个人简介', submitLabel: '保存简介',
			fields: [
				{ name: 'profile_nickname', label: '昵称', maxLength: maxNicknameWidth, extra: `显示名，本站内唯一，可以用各国语言；宽度 ${minNicknameWidth} 到 ${maxNicknameWidth} 个半角字符（一个全角按两个半角计）。默认就是用户名，改成别的才会单独保存。` },
				{ name: 'profile_qq', label: 'QQ', maxLength: 20 },
				{ name: 'profile_wechat', label: '微信号', maxLength: 64 },
				{ name: 'profile_email', label: '联系邮箱', maxLength: 254, extra: '本站不做验证，仅作联系方式。' },
			],
		},
		{
			key: 'password', title: hasPassword ? '修改密码' : '设置密码', submitLabel: hasPassword ? '修改密码' : '设置密码',
			description: hasPassword ? '改密码要先验证当前密码。' : '这个账号还没有本站密码。设置之后就能用用户名和密码直接登录本站。',
			fields: [
				...(hasPassword ? [{ name: 'currentPassword', label: '当前密码', type: 'password' as const, rules: [{ required: true, message: '请输入当前密码' }] }] : []),
				{ name: 'newPassword', label: hasPassword ? '新密码' : '密码', type: 'password' as const, extra: '至少 8 个字符。', rules: [{ required: true, message: '请输入密码' }] },
			],
		},
	],
});

const loadProfile = (c: Parameters<ApiHandler>[0], userId: string | number) => firstSql<ProfileRow>(c.get('database'), sql({ database: c.get('database') }).select({
	table: 'base_users', alias: 'u',
	columns: { user_name: 'u.name', profile_nickname: 'p.nickname', profile_qq: 'p.qq', profile_wechat: 'p.wechat', profile_email: 'p.email' },
	joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }],
	where: [{ column: 'u.id', value: userId }],
}));

/**
 * 个人中心：展示当前登录身份，并允许改自己的用户名、简介与密码。
 *
 * 只能改**自己**这一行——用的是会话里的 currentUser.id，请求体里带别人的 ID 也没用。
 * 账户中心入口始终在新页面打开：业务站点不会把当前页面带去其它域名。
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
				accountsNotice: `本站账号与 Accounts 账号中心（${issuer.host}）各自独立：绑定之后两边的用户名和昵称互不影响，这里改的只是本站账号。点击下面的按钮会在新页面打开账号中心，当前页面不会离开。`,
				accountsCenter: { label: '在新页面打开账号中心', url: `${issuer.origin}/panel/accounts` },
			}
			: undefined;
		const row = currentUser ? await loadProfile(c, currentUser.id) : undefined;
		return apiResponse(c, 200, {
			user: currentUser,
			...(accounts ?? {}),
			...(row ? { formPage: profileForm(row, await hasCredential(database, currentUser!.id)) } : {}),
		});
	}
	if (c.req.method !== 'PUT') return next();
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const section = String(body[SECTION_FIELD] ?? '');
	const tenantId = c.get('tenantId');
	const scope = ownerScope('owner_tid', tenantId);
	const saved = async (message: string) => {
		const row = await loadProfile(c, currentUser.id);
		return apiMessageData(c, 200, message, row ? { formPage: profileForm(row, await hasCredential(database, currentUser.id)) } : {}, { component: 'inline', showIcon: true, title: '保存结果' });
	};

	if (section === 'user_name') {
		const userName = String(body.user_name ?? '').trim();
		const error = userNameError(userName, c.get('siteSettings').userNameMinLength);
		if (error) return apiMessage(c, 400, error);
		const taken = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: userName }, { column: 'id', operator: '!=', value: currentUser.id }, scope], limit: 1 }));
		if (taken) return apiMessage(c, 409, '该用户名已被占用，请换一个');
		await runOperation(c, database, [sql({ database }).update('base_users', { name: userName }, { id: currentUser.id })]);
		return saved('用户名已保存');
	}

	if (section === 'profile') {
		const fields = Object.fromEntries((['profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email'] as const)
			.filter((name) => name in body).map((name) => [name, String(body[name] ?? '')]));
		if (!Object.keys(fields).length) return apiMessage(c, 400, '没有可修改的字段');
		const result = await profileStatement(database, currentUser.id, fields, scope);
		if ('error' in result) return apiMessage(c, 400, result.error);
		await runOperation(c, database, ['statement' in result ? result.statement : result.clear]);
		return saved('个人简介已保存');
	}

	if (section === 'password') {
		const newPassword = String(body.newPassword ?? '');
		// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
		// 还没有密码的账号（走 Accounts 建的）没什么可验，直接设。
		if (await hasCredential(database, currentUser.id) && !await verifyCredential(database, currentUser.id, String(body.currentPassword ?? ''))) {
			return apiMessage(c, 403, '当前密码不正确');
		}
		const error = passwordError(newPassword);
		if (error) return apiMessage(c, 400, error);
		await runOperation(c, database, [await credentialStatement(database, currentUser.id, newPassword)]);
		return saved('密码已保存');
	}
	return apiMessage(c, 400, '请选择要保存的一组设置');
};

export default handler;
