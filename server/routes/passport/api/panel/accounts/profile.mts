import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { loadAccountProfile, setAccountUsername, updateAccountNickname } from '@server/modules/passport/account.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const profileForm = (): FormPageConfig => ({
	description: '用户名可修改，必须以小写字母开头，只能包含小写字母和数字，长度 6 到 12 位；昵称最多 12 个字符。',
	submitLabel: '保存',
	initialValues: { locked: '1', username: '', nickname: '', primary_email: '' },
	fields: [
		{ name: 'locked', label: '', type: 'hidden' },
		{ name: 'username', label: '用户名', maxLength: 12, rules: [{ required: true, message: '请输入用户名' }] },
		{ name: 'nickname', label: '昵称', maxLength: 12, rules: [{ required: true, message: '请输入昵称' }] },
		{ name: 'primary_email', label: '主邮箱', readOnlyWhen: { field: 'locked', values: ['1'] } },
	],
});

const handler: ApiHandler = async (c, next) => {
	const database = c.get('passportDatabase')!, userId = String(c.get('passportUser')!.id);
	if (c.req.method === 'GET') {
		const profile = await loadAccountProfile(database, userId);
		return apiResponse(c, 200, {
			formPage: profileForm(),
			currentValues: { locked: '1', username: profile.username ?? '', nickname: profile.nickname, primary_email: profile.primaryEmail || '未设置' },
		});
	}
	if (c.req.method !== 'PUT') return next();
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const current = await loadAccountProfile(database, userId);
	let nickname: string, username = current.username ?? '';
	try {
		const requestedUsername = String(body.username ?? '').trim();
		// 用户名是 passport_users.name 的必填字段；占位名或空值都必须先改成正式用户名。
		username = await setAccountUsername(database, userId, requestedUsername);
		nickname = await updateAccountNickname(database, userId, String(body.nickname ?? ''));
	}
	catch (error) { return apiMessage(c, 400, error instanceof Error ? error.message : '昵称不合法'); }
	return apiMessageData(c, 200, '资料已保存', {
		currentValues: { locked: '1', username, nickname, primary_email: current.primaryEmail || '未设置' },
	});
};

export default handler;
