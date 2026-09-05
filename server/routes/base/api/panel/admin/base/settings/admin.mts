import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import { defaultSiteSettings, loadSiteSettings, normalizeSiteSettings } from '@server/modules/base/site-settings.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

/**
 * 后台：**管理后台自己的参数**，访客一辈子碰不到。
 *
 * 与前台那两张共用 `site_settings` 一条配置，因此三张表单的待审批提示看到的是同一行——
 * 它们本来就是同一条记录。
 */
const formPage = {
	description: '配置管理后台自己的部分：侧栏形态、审批留痕的保留期。',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
	submitLabel: '保存配置',
	actions: [{ key: 'restore-defaults', label: '恢复默认', confirm: '确认恢复后台设置的默认值吗？恢复后需要点击“保存配置”才会生效。' }],
	initialValues: defaultSiteSettings,
	defaultValues: defaultSiteSettings,
	fields: [
		{ name: 'adminMenuFoldable', label: '顶层菜单可折叠', type: 'switch', defaultValue: false, extra: '关闭时侧栏的顶层模块用分组标题加分隔线摊开，一眼看全；接的模块多到侧栏装不下时打开它，顶层会变回可折叠的子菜单。' },
		// 保留期只能由平台管理员改：租户管理员能缩短自己的留痕保留期，等于给了销毁证据的手段。
		// 这个表单本就在「系统设置」下，父级角色门已限定 platform_admin。
		{ name: 'auditRetentionDays', label: '审批留痕保留天数', type: 'text', extra: '超过该天数的变更记录会被物理删除；填 0 表示不自动清理。', placeholder: '365', maxLength: 4 },
	],
} satisfies FormPageConfig;

const fields = ['adminMenuFoldable', 'auditRetentionDays'] as const;

export default settingsPageHandler({
	key: 'site_settings',
	load: (c) => loadSiteSettings(c.get('configStore')),
	formPage: () => formPage,
	parse: (c, body, current) => normalizeSiteSettings(mergeChangedFields(current, body, fields)),
	apply: (c, settings) => c.set('siteSettings', settings),
	saved: '后台设置已保存',
});
