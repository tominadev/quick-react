import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { loadAccountProfile, setAccountUserName, updateProfileNickname } from '@server/modules/passport/account.mjs';
import { maxNicknameWidth, maxUserNameLength, minNicknameWidth } from '@shared/account-name.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const profileForm = (): FormPageConfig => ({
	description: `用户名可修改，必须以小写字母开头，只能包含小写字母和数字，最长 ${maxUserNameLength} 位；昵称宽度 ${minNicknameWidth} 到 ${maxNicknameWidth} 个半角字符（一个全角按两个半角计）。`,
	submitLabel: '保存',
	initialValues: { locked: '1', user_name: '', profile_nickname: '', primary_email: '' },
	fields: [
		{ name: 'locked', label: '', type: 'hidden' },
		{ name: 'user_name', label: '用户名', maxLength: maxUserNameLength, rules: [{ required: true, message: '请输入用户名' }] },
		{ name: 'profile_nickname', label: '昵称', maxLength: maxNicknameWidth, rules: [{ required: true, message: '请输入昵称' }] },
		{ name: 'primary_email', label: '主邮箱', readOnlyWhen: { field: 'locked', values: ['1'] } },
	],
});

const handler: ApiHandler = async (c, next) => {
	const database = c.get('passportDatabase')!, userId = String(c.get('passportUser')!.id);
	if (c.req.method === 'GET') {
		const profile = await loadAccountProfile(database, userId);
		return apiResponse(c, 200, {
			formPage: profileForm(),
			currentValues: { locked: '1', user_name: profile.user_name ?? '', profile_nickname: profile.profile_nickname, primary_email: profile.primaryEmail || '未设置' },
		});
	}
	if (c.req.method !== 'PUT') return next();
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const current = await loadAccountProfile(database, userId);
	let profileNickname: string, userName = current.user_name ?? '';
	try {
		const requestedUserName = String(body.user_name ?? '').trim();
		// 用户名是 passport_users.name 的必填字段；占位名或空值都必须先改成正式用户名。
		userName = await setAccountUserName(c, database, userId, requestedUserName, c.get('siteSettings').userNameMinLength);
		profileNickname = await updateProfileNickname(c, database, userId, String(body.profile_nickname ?? ''));
	}
	catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '昵称不合法'); }
	return apiMessageData(c, 200, '资料已保存', {
		currentValues: { locked: '1', user_name: userName, profile_nickname: profileNickname, primary_email: current.primaryEmail || '未设置' },
	});
};

export default handler;
