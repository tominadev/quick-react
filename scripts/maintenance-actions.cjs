const { createPm2Service, validateAppName, DEFAULT_LOG_LINES } = require('./maintenance-service-pm2.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const configuredAppName = (env = process.env) => {
	const value = String(env.PM2_APP_NAME ?? '').trim();
	return value ? validateAppName(value) : '';
};

const askAppName = async (ask, env) => {
	const configured = configuredAppName(env);
	if (configured) return configured;
	if (typeof ask !== 'function') throw new Error('未配置 PM2_APP_NAME，无法确定目标服务');
	return validateAppName(await ask('请输入 PM2 应用名：'));
};

const confirmTarget = async (ask, operation, appName) => {
	if (typeof ask !== 'function') throw new Error('缺少交互确认上下文');
	const answer = await ask(`将通过 PM2 ${operation} 服务“${appName}”，确认继续？\n请输入 yes 确认：`);
	return String(answer).trim().toLowerCase() === 'yes';
};

let maintenanceRuntimePromise;
const loadMaintenanceRuntime = async () => {
	if (maintenanceRuntimePromise) return maintenanceRuntimePromise;
	const runtimePath = path.resolve(__dirname, '../dist/server.mjs');
	const previousListen = process.env.SKIP_SERVER_LISTEN;
	const previousChecks = process.env.SKIP_STARTUP_CHECKS;
	process.env.SKIP_SERVER_LISTEN = '1';
	process.env.SKIP_STARTUP_CHECKS = '1';
	maintenanceRuntimePromise = import(`${pathToFileURL(runtimePath).href}?maintenance=${Date.now()}`).then((runtime) => {
		if (typeof runtime.runMaintenanceAction !== 'function') throw new Error('当前构建未包含维护救援入口，请先重新构建项目');
		return runtime;
	}).finally(() => {
		if (previousListen === undefined) delete process.env.SKIP_SERVER_LISTEN;
		else process.env.SKIP_SERVER_LISTEN = previousListen;
		if (previousChecks === undefined) delete process.env.SKIP_STARTUP_CHECKS;
		else process.env.SKIP_STARTUP_CHECKS = previousChecks;
	});
	try { return await maintenanceRuntimePromise; }
	catch (error) {
		maintenanceRuntimePromise = undefined;
		throw error;
	}
};

const runRescueAction = async (action, input) => {
	const runtime = await loadMaintenanceRuntime();
	return runtime.runMaintenanceAction(action, input);
};

const configuredValue = (env, key) => String(env[key] ?? '').trim();
const configuredSecret = (env, key) => String(env[key] ?? '');
const askSecretValue = async (askSecret, env, envKey, prompt) => {
	const configured = configuredSecret(env, envKey);
	if (configured) {
		if (configured.length < 8) throw new Error('密码至少需要 8 个字符');
		return configured;
	}
	if (typeof askSecret !== 'function') throw new Error(`请设置 ${envKey}；密码不接受命令行参数，也不会回显到菜单`);
	let currentPrompt = prompt;
	while (true) {
		const value = String(await askSecret(currentPrompt));
		if (value.length >= 8) return value;
		currentPrompt = '密码至少需要 8 个字符，请重新输入（输入内容以星号显示）：';
	}
};
const askValue = async (ask, env, envKey, prompt, { required = true } = {}) => {
	const configured = configuredValue(env, envKey);
	if (configured) return configured;
	if (typeof ask !== 'function') {
		if (required) throw new Error(`未设置 ${envKey}，无法执行救援操作`);
		return '';
	}
	const value = String(await ask(prompt)).trim();
	if (required && !value) throw new Error(`请输入${prompt.replace(/[：:？?]$/, '')}`);
	return value;
};

const confirmRescue = async (ask, message) => {
	if (typeof ask !== 'function') throw new Error('缺少交互确认上下文');
	const answer = await ask(`${message}\n请输入 yes 确认：`);
	return String(answer).trim().toLowerCase() === 'yes';
};

/**
 * Service actions intentionally target PM2, not the process that happens to
 * invoke this module. The dev runner only assembles and calls these actions.
 */
const createMaintenanceActions = ({ service = createPm2Service(), env = process.env } = {}) => ({
	groups: [{
		key: 'rescue',
		label: '救援与登录恢复',
		actions: [
			{
				key: 'admin-status',
				label: '查看基础管理员状态',
				description: '查看 base_users.id=1 的非敏感状态',
				run: () => runRescueAction('admin-status', {}),
			},
			{
				key: 'restore-admin',
				label: '恢复基础管理员 id=1',
				description: '恢复删除标记、启用状态并确保 admin 角色',
				run: async ({ ask } = {}) => {
					const username = await askValue(ask, env, 'MAINTENANCE_ADMIN_USERNAME', '请输入管理员用户名（留空使用现有用户名或 admin）：', { required: false });
					const password = configuredSecret(env, 'MAINTENANCE_ADMIN_PASSWORD');
					if (!await confirmRescue(ask, '将恢复 base_users.id=1 的管理员状态；若记录不存在则使用提供的信息重建，确认继续？')) return '已取消';
					return runRescueAction('restore-admin', { username, password });
				},
			},
			{
				key: 'set-admin-username',
				label: '设置基础管理员用户名',
				description: '只修改 base_users.id=1 的用户名',
				run: async ({ ask } = {}) => {
					const username = await askValue(ask, env, 'MAINTENANCE_ADMIN_USERNAME', '请输入新的管理员用户名：');
					if (!await confirmRescue(ask, `将把 base_users.id=1 的用户名设置为“${username}”，确认继续？`)) return '已取消';
					return runRescueAction('set-admin-username', { username });
				},
			},
			{
				key: 'set-admin-password',
				label: '重设基础管理员密码',
				description: '直接输入新密码，输入内容以星号显示；非交互模式可使用环境 Secret',
				run: async ({ ask, askSecret } = {}) => {
					const password = await askSecretValue(askSecret, env, 'MAINTENANCE_ADMIN_PASSWORD', '请输入新的管理员密码（至少 8 个字符，输入内容以星号显示）：');
					if (!await confirmRescue(ask, '将重设 base_users.id=1 的密码并使本站 Base 会话按现有规则重新校验，确认继续？')) return '已取消';
					return runRescueAction('set-admin-password', { password });
				},
			},
			{
				key: 'accounts-oidc-status',
				label: '查看 Accounts OIDC 状态',
				description: '显示开关、Issuer 和客户端 ID，不显示密钥',
				run: () => runRescueAction('accounts-oidc-status', {}),
			},
			{
				key: 'disable-accounts-oidc',
				label: '关闭 Accounts OIDC 登录',
				description: '让共享当前数据库的站点回到本地用户名密码登录',
				run: async ({ ask } = {}) => {
					if (!await confirmRescue(ask, '将关闭 Accounts OIDC 登录，不删除账号、外部身份、会话或客户端密钥，确认继续？')) return '已取消';
					return runRescueAction('disable-accounts-oidc', {});
				},
			},
			{
				key: 'enable-accounts-oidc',
				label: '启用 Accounts OIDC 登录',
				description: '使用现有有效配置启用统一登录',
				run: async ({ ask } = {}) => {
					if (!await confirmRescue(ask, '将启用 Accounts OIDC 登录；如果 Issuer、客户端 ID 或密钥无效，登录可能继续失败，确认继续？')) return '已取消';
					return runRescueAction('enable-accounts-oidc', {});
				},
			},
			{
				key: 'restore-accounts-oidc-defaults',
				label: '恢复 Accounts OIDC 默认配置',
				description: '关闭登录并清空 Issuer、客户端 ID 和客户端密钥',
				run: async ({ ask } = {}) => {
					if (!await confirmRescue(ask, '将恢复 Accounts OIDC 默认配置并关闭登录，确认继续？')) return '已取消';
					return runRescueAction('restore-accounts-oidc-defaults', {});
				},
			},
		],
	}, {
		key: 'service',
		label: '服务管理（PM2）',
		actions: [
			{
				key: 'pm2-status',
				label: '查看服务状态',
				description: '读取 PM2 进程列表，不操作当前开发进程',
				run: () => service.status(),
			},
			{
				key: 'pm2-restart',
				label: '重启服务',
				description: '通过 PM2 重启指定应用',
				run: async ({ ask } = {}) => {
					const appName = await askAppName(ask, env);
					if (!await confirmTarget(ask, '重启', appName)) return '已取消';
					return service.restart(appName);
				},
			},
			{
				key: 'pm2-stop',
				label: '停止服务',
				description: '通过 PM2 停止指定应用',
				run: async ({ ask } = {}) => {
					const appName = await askAppName(ask, env);
					if (!await confirmTarget(ask, '停止', appName)) return '已取消';
					return service.stop(appName);
				},
			},
			{
				key: 'pm2-logs',
				label: '查看服务日志',
				description: `显示指定应用最近 ${DEFAULT_LOG_LINES} 行日志`,
				run: async ({ ask } = {}) => service.logs(await askAppName(ask, env), DEFAULT_LOG_LINES),
			},
		],
	}],
});

module.exports = { createMaintenanceActions, askAppName };
