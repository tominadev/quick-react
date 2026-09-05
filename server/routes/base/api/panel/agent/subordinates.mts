import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { claimSubordinate, listSubordinates } from '@server/modules/base/agent.mjs';
import { profileNicknameOf } from '@server/modules/base/profile.mjs';
import { enabledDisabledOptions } from '@shared/types/status.mjs';
import { maxUserNameLength } from '@shared/account-name.mjs';

const columns = [
	{ dataIndex: 'user_name', title: '用户名' },
	{ dataIndex: 'profile_nickname', title: '昵称' },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'status', title: '状态', component: 'select' as const, options: enabledDisabledOptions }];

/**
 * 拉号只问一个用户名。
 *
 * 不做下拉选择，也不提供「还没有代理的用户」列表：那等于把整个待发展名单摆出来，
 * 谁先点谁拿走。要拉谁得先知道他叫什么，这一条本身就是这个动作唯一的门槛。
 */
const claimColumns = [{ dataIndex: 'user_name', title: '用户名', component: 'textbox' as const, placeholder: '对方在本站的登录用户名', maxLength: maxUserNameLength, rules: [{ required: true, message: '请输入用户名' }] }];

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	if (!params.id && c.req.method === 'POST' && c.req.query('action') === 'claim') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const result = await claimSubordinate(c, database, String(body.user_name ?? ''));
		if ('error' in result) return apiMessage(c, 409, result.error);
		return apiMessageData(c, 200, `已把「${result.user.user_name}」拉为下级`, result.user);
	}
	if (c.req.method !== 'GET' || params.id) return next();
	const rows = await listSubordinates(database, String(currentUser.id));
	const dataSource = rows.map((row) => ({ ...row, profile_nickname: profileNicknameOf(String(row.user_name ?? ''), row.profile_nickname as string | null) }));
	return apiResponse(c, 200, { table: {
		option: { rowKey: 'id', actions: { toolbar: [{ key: 'claim', label: '拉号', form: { columns: claimColumns }, confirm: '确认把这个用户拉为自己的下级吗？' }] } },
		columns, dataSource, totalRecords: dataSource.length,
	} });
};

export const acceptsTrailingParams = true;
export default handler;
