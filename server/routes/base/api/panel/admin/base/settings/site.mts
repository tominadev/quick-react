import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import { defaultSiteSettings, normalizeSiteSettings } from '@server/modules/base/site-settings.mjs';
import { defaultMinUserNameLength, maxUserNameLength } from '@shared/account-name.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const formPage = {
	description: '配置当前站点的联系信息、页脚、退出登录入口和页面启动模式。',
	submitLabel: '保存配置',
	actions: [{ key: 'restore-defaults', label: '恢复默认', confirm: '确认恢复所有站点设置的默认值吗？恢复后需要点击“保存配置”才会生效。' }],
	initialValues: defaultSiteSettings,
	defaultValues: defaultSiteSettings,
	fields: [
		{ name: 'contactEmail', label: '联系邮箱', type: 'text', placeholder: 'support@example.com', maxLength: 254 },
		{ name: 'footer', label: '页脚内容', type: 'text', placeholder: 'Ant Design ©2026 Created by Ant UED', maxLength: 512, defaultValue: defaultSiteSettings.footer },
		{ name: 'logoutLocalEnabled', label: '启用“退出本站”', type: 'switch', defaultValue: false },
		{ name: 'logoutPassportEnabled', label: '启用“退出 Passport”', type: 'switch', defaultValue: false },
		{ name: 'logoutAllEnabled', label: '启用“退出登录”', type: 'switch', defaultValue: true },
		{ name: 'apiBootstrapEnabled', label: '启用 API 页面启动（CDN 模式）', type: 'switch', defaultValue: true },
		// 保留期只能由平台管理员改：租户管理员能缩短自己的审计保留期，等于给了销毁证据的手段。
		// 这个表单本就在「系统设置」下，父级角色门已限定 platform_admin。
		{ name: 'localLoginEnabled', label: '保留本站登录', type: 'switch', defaultValue: false, extra: '接入 Accounts 后仍然允许用本站用户名密码登录。请在启用 Accounts 登录之前先打开它——启用那一刻本地会话会立即失效，之后就进不来改这个开关了。' },
		{ name: 'passwordSyncEnabled', label: '同步 Accounts 密码', type: 'switch', defaultValue: false, extra: '每次 Accounts 登录时把密码同步到本站账号，让两边用同一个密码。需要 Accounts 那边也为本站的 OIDC 客户端打开下发开关；本站库里会因此多一份能直接破出 Accounts 密码的哈希。' },
		{ name: 'registrationEnabled', label: '允许用户注册', type: 'switch', defaultValue: false, extra: '开启后任何人都能在本站注册普通账号；关闭时只保留尚未使用的初始管理员入口。' },
		{ name: 'userNameMinLength', label: '用户名最短位数', type: 'text', extra: `用户名只能是小写字母开头的小写字母数字组合，最长 ${maxUserNameLength} 位；这里设置的是最短位数（1 到 ${maxUserNameLength}）。`, placeholder: String(defaultMinUserNameLength), maxLength: 2 },
		{ name: 'auditRetentionDays', label: '审计保留天数', type: 'text', extra: '超过该天数的变更记录会被物理删除；填 0 表示不自动清理。', placeholder: '365', maxLength: 4 },
	],
} satisfies FormPageConfig;

const handler: ApiHandler = async (c, next) => {
	if (c.req.method === 'GET') return apiResponse(c, 200, { currentValues: c.get('siteSettings'), formPage });
	if (c.req.method === 'PUT') {
		const body = await c.req.json<unknown>().catch(() => ({}));
		const settings = normalizeSiteSettings(mergeChangedFields(c.get('siteSettings'), body, ['contactEmail', 'footer', 'logoutLocalEnabled', 'logoutPassportEnabled', 'logoutAllEnabled', 'apiBootstrapEnabled', 'userNameMinLength', 'auditRetentionDays', 'registrationEnabled', 'localLoginEnabled', 'passwordSyncEnabled']));
		await c.get('configStore').put('site-settings', settings);
		c.set('siteSettings', settings);
		return apiMessageData(c, 200, '站点设置已保存', { currentValues: settings }, { component: 'inline', showIcon: true, title: '保存结果' });
	}
	return next();
};
export default handler;
