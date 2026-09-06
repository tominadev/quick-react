import { getDefaultSystemConfig, loadSystemConfigFromStore, normalizeSystemConfig } from '@server/modules/base/system-config.mjs';
import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { mergeChangedFields } from '@server/modules/base/changed-fields.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

const createFormPage = (): FormPageConfig => {
	const defaults = getDefaultSystemConfig();
	return {
		description: '系统运行参数。修改后需要重启服务才能生效。',
		submitLabel: '保存配置',
		actions: [{ key: 'restore-defaults', label: '重置默认', confirm: '确认重置系统设置的默认值吗？重置后需要点击“保存配置”才会生效。' }],
		confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
		submitHint: '部分配置需要重启服务后生效',
		initialValues: defaults,
		defaultValues: defaults,
		fields: [
			{ name: 'httpPort', label: 'HTTP 端口', type: 'text', extra: '修改后需要重启服务，例如 8088。', placeholder: '8088', maxLength: 5 },
			{ name: 'domain', label: '域名', type: 'text', extra: '用于 HTTPS 证书目录和服务域名。', placeholder: 'anan.cc', maxLength: 253 },
			{ name: 'publicOrigin', label: '公共 Origin', type: 'text', extra: '用于 canonical URL，例如 https://example.com；可留空。', placeholder: 'https://example.com', maxLength: 512 },
			{ name: 'trustedProxyIps', label: '可信代理 IP', type: 'text', extra: '逗号分隔；用于解析客户端真实 IP。', placeholder: '127.0.0.1,10.0.0.10', maxLength: 2048 },
			{ name: 'mapAllowedIps', label: 'Source Map 允许 IP', type: 'text', extra: '逗号分隔；用于限制所有 .map 源码映射文件访问。', placeholder: '127.0.0.1', maxLength: 2048 },
			{ name: 'debug', label: '调试模式', type: 'switch', defaultValue: false, extra: '开启后显示 Passport 登录等内部流程的详细错误；生产环境建议关闭。' },
		],
	};
};

export default settingsPageHandler({
	key: 'system_config',
	load: (c) => loadSystemConfigFromStore(c.get('configStore')),
	formPage: () => createFormPage(),
	parse: (c, body, current) => normalizeSystemConfig(mergeChangedFields(current, body, ['httpPort', 'domain', 'publicOrigin', 'trustedProxyIps', 'mapAllowedIps', 'debug'])),
	apply: (c, config) => c.set('systemConfig', config),
	saved: '系统配置已保存，重启服务后生效',
});
