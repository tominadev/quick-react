import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import { defaultSiteSettings, loadSiteSettings, normalizeSiteSettings } from '@server/modules/base/site-settings.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

/**
 * 前台前端：**浏览器里渲染出来的东西**——文案、入口、加载方式。
 *
 * 三张表单共用 `site_settings` 一条配置，只是按「这个值管的是哪一层」分开：
 * 渲染在这里，前台的服务端策略在 site-backend，管理后台自己的在 admin。
 * 一张表单里既有页脚文案又有审计保留天数的话，改前者的人得先在十几行里认出
 * 哪几行与自己无关。
 */
const formPage = {
	description: '配置访客在浏览器里看到的部分：联系方式、页脚、退出登录入口、页面启动模式。',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
	submitLabel: '保存配置',
	actions: [{ key: 'restore-defaults', label: '恢复默认', confirm: '确认恢复前台前端设置的默认值吗？恢复后需要点击“保存配置”才会生效。' }],
	initialValues: defaultSiteSettings,
	defaultValues: defaultSiteSettings,
	fields: [
		{ name: 'contactEmail', label: '联系邮箱', type: 'text', placeholder: 'support@example.com', maxLength: 254 },
		{ name: 'footer', label: '页脚内容', type: 'text', placeholder: 'Ant Design ©2026 Created by Ant UED', maxLength: 512, defaultValue: defaultSiteSettings.footer },
		{ name: 'apiBootstrapEnabled', label: '启用 API 页面启动（CDN 模式）', type: 'switch', defaultValue: true },
		{ name: 'logoutLocalEnabled', label: '启用“退出本站”', type: 'switch', defaultValue: false },
		{ name: 'logoutPassportEnabled', label: '启用“退出 Passport”', type: 'switch', defaultValue: false },
		{ name: 'logoutAllEnabled', label: '启用“退出登录”', type: 'switch', defaultValue: true },
	],
} satisfies FormPageConfig;

const fields = ['contactEmail', 'footer', 'apiBootstrapEnabled', 'logoutLocalEnabled', 'logoutPassportEnabled', 'logoutAllEnabled'] as const;

export default settingsPageHandler({
	key: 'site_settings',
	load: (c) => loadSiteSettings(c.get('configStore')),
	formPage: () => formPage,
	parse: (c, body, current) => normalizeSiteSettings(mergeChangedFields(current, body, fields)),
	apply: (c, settings) => c.set('siteSettings', settings),
	saved: '前台前端设置已保存',
});
