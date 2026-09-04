import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import { defaultSiteSettings, normalizeSiteSettings } from '@server/modules/base/site-settings.mjs';
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
		{ name: 'auditRetentionDays', label: '审计保留天数', type: 'text', extra: '超过该天数的变更记录会被物理删除；填 0 表示不自动清理。', placeholder: '365', maxLength: 4 },
	],
} satisfies FormPageConfig;

const handler: ApiHandler = async (c, next) => {
	if (c.req.method === 'GET') return apiResponse(c, 200, { currentValues: c.get('siteSettings'), formPage });
	if (c.req.method === 'PUT') {
		const body = await c.req.json<unknown>().catch(() => ({}));
		const settings = normalizeSiteSettings(mergeChangedFields(c.get('siteSettings'), body, ['contactEmail', 'footer', 'logoutLocalEnabled', 'logoutPassportEnabled', 'logoutAllEnabled', 'apiBootstrapEnabled', 'auditRetentionDays']));
		await c.get('configStore').put('site-settings', settings);
		c.set('siteSettings', settings);
		return apiMessageData(c, 200, '站点设置已保存', { currentValues: settings }, { component: 'inline', showIcon: true, title: '保存结果' });
	}
	return next();
};
export default handler;
