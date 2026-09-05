import { getDefaultTechStackConfig, loadTechStackConfigFromStore, normalizeTechStackConfig } from '@server/modules/base/tech-stack.mjs';
import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const createFormPage = (): FormPageConfig => {
	const defaults = getDefaultTechStackConfig();
	return {
		description: '配置会作用于后续 HTTP 响应，并保存到服务器配置文件。仅用于兼容性测试、演示或隐藏真实服务实现。',
		submitLabel: '保存配置',
		actions: [{ key: 'restore-defaults', label: '恢复默认', confirm: '确认恢复技术栈设置的默认值吗？恢复后需要点击“保存配置”才会生效。' }],
		confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
		submitHint: '修改后立即生效',
		initialValues: defaults,
		defaultValues: defaults,
		fields: [
			{ name: 'nginx', label: 'Nginx', type: 'switch', defaultValue: false, checkedChildren: '开启', unCheckedChildren: '关闭', extra: '开启后返回 Server: nginx。' },
			{ name: 'phpVersion', label: 'PHP 版本号', type: 'text', extra: '填写例如 8.2.12；留空则不返回 PHP 标识。', placeholder: '例如 8.2.12', maxLength: 32 },
			{ name: 'apiSuffix', label: 'API 路径后缀', type: 'text', extra: '例如 .php、.json；留空则使用无后缀 API 路径。', placeholder: '例如 .php', maxLength: 16 },
			{ name: 'pageSuffix', label: '页面路径后缀', type: 'text', extra: '例如 .html；留空则使用无后缀页面路径。', placeholder: '例如 .html', maxLength: 16 },
		],
	};
};

export default settingsPageHandler({
	key: 'tech-stack',
	load: (c) => loadTechStackConfigFromStore(c.get('configStore')),
	formPage: () => createFormPage(),
	parse: (c, body, current) => normalizeTechStackConfig(mergeChangedFields(current, body, ['nginx', 'phpVersion', 'apiSuffix', 'pageSuffix'])),
	apply: (c, config) => c.set('techStackConfig', config),
	saved: '保存成功，页面将在 {redirectAfter} 秒后刷新',
	// 改的是 API/页面路径后缀，当前页面的地址随之失效，只能整页重载。
	savedFeedback: { component: 'modal', type: 'info', title: '保存结果', refreshNowLabel: '立即刷新', cancelRefreshLabel: '取消', redirectAfter: 2 },
});
