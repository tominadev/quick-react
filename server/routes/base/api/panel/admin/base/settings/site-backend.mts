import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import { defaultSiteSettings, loadSiteSettings, normalizeSiteSettings } from '@server/modules/base/site-settings.mjs';
import { defaultMinUserNameLength, maxUserNameLength } from '@shared/account-name.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

/**
 * 前台后端：**前台站点的服务端策略**——放不放行、按什么规则校验。
 *
 * 访客感知得到（注册被拒、密码不合规），但它不是渲染出来的东西，改错了也不是「界面难看」
 * 而是「人进不来」或者「谁都进得来」。因此与前台前端分开：那一张改的是文案，这一张改的是门。
 */
const formPage = {
	description: '配置前台站点的服务端策略：谁能注册、能用哪几种方式登录、账号规则。',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
	submitLabel: '保存配置',
	actions: [{ key: 'restore-defaults', label: '恢复默认', confirm: '确认恢复前台后端设置的默认值吗？恢复后需要点击“保存配置”才会生效。' }],
	initialValues: defaultSiteSettings,
	defaultValues: defaultSiteSettings,
	fields: [
		{ name: 'registrationEnabled', label: '允许用户注册', type: 'switch', defaultValue: false, extra: '开启后任何人都能在本站注册普通账号；关闭时只保留尚未使用的初始管理员入口。' },
		{ name: 'localLoginEnabled', label: '保留本站登录', type: 'switch', defaultValue: false, extra: '接入 Accounts 后仍然允许用本站用户名密码登录。请在启用 Accounts 登录之前先打开它——启用那一刻本地会话会立即失效，之后就进不来改这个开关了。' },
		{ name: 'passwordSyncEnabled', label: '同步 Accounts 密码', type: 'switch', defaultValue: false, extra: '每次 Accounts 登录时把密码同步到本站账号，让两边用同一个密码。需要 Accounts 那边也为本站的 OIDC 客户端打开下发开关；本站库里会因此多一份能直接破出 Accounts 密码的哈希。' },
		{ name: 'userNameMinLength', label: '用户名最短位数', type: 'text', extra: `用户名只能是小写字母开头的小写字母数字组合，最长 ${maxUserNameLength} 位；这里设置的是最短位数（1 到 ${maxUserNameLength}）。`, placeholder: String(defaultMinUserNameLength), maxLength: 2 },
	],
} satisfies FormPageConfig;

const fields = ['registrationEnabled', 'localLoginEnabled', 'passwordSyncEnabled', 'userNameMinLength'] as const;

export default settingsPageHandler({
	key: 'site_settings',
	load: (c) => loadSiteSettings(c.get('configStore')),
	formPage: () => formPage,
	parse: (c, body, current) => normalizeSiteSettings(mergeChangedFields(current, body, fields)),
	apply: (c, settings) => c.set('siteSettings', settings),
	saved: '前台后端设置已保存',
});
