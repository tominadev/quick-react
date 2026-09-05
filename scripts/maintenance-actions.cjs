const { createPm2Service, DEFAULT_LOG_LINES } = require('./maintenance-service-pm2.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const describeTarget = (target) => {
	if (!target || typeof target !== 'object') return String(target ?? '当前项目服务');
	const cluster = Number(target.instanceCount) > 1 ? `（${target.instanceCount} 个 Cluster 实例）` : '';
	const desired = target.desiredInstances ? `，目标 ${target.desiredInstances} 个实例` : '';
	return `${target.name ?? '当前项目服务'}${cluster}${desired}`;
};

const confirmTarget = async (ask, operation, target) => {
	if (typeof ask !== 'function') throw new Error('缺少交互确认上下文');
	const answer = await ask(`将通过 PM2 ${operation}“${describeTarget(target)}”，确认继续？\n请输入 yes 确认：`);
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

const askInstanceCount = async (ask, env, service, currentCount) => {
	const configured = configuredValue(env, 'PM2_INSTANCES');
	const fallback = currentCount ? String(currentCount) : 'max';
	if (configured) return service.normalizeInstances(configured);
	if (typeof ask !== 'function') return service.normalizeInstances(fallback);
	let prompt = `请输入 Cluster 实例数（当前 ${currentCount || '未注册'}，直接回车使用 ${fallback}）：`;
	while (true) {
		const value = String(await ask(prompt)).trim() || fallback;
		try { return service.normalizeInstances(value); }
		catch (error) {
			prompt = `实例数无效：${error instanceof Error ? error.message : String(error)}\n请重新输入（直接回车使用 ${fallback}）：`;
		}
	}
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
const createMaintenanceActions = ({
	service = createPm2Service(),
	env = process.env,
	projectDir = '',
	beforePm2Start,
	followPm2Logs,
	stopPm2Logs,
} = {}) => {
	const ownService = async () => {
		const own = await service.findOwn({ projectDir, pmId: env.pm_id, appName: env.PM2_APP_NAME });
		if (!own) throw new Error('当前项目未注册 PM2 服务，不会操作其他应用');
		return own;
	};
	const serviceName = () => service.resolveName({ projectDir, appName: env.PM2_APP_NAME });
	const followOwnLogs = async () => {
		if (typeof followPm2Logs !== 'function') return;
		const target = await ownService();
		await followPm2Logs(target);
	};
	return {
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
					const userName = await askValue(ask, env, 'MAINTENANCE_ADMIN_USER_NAME', '请输入管理员用户名（留空使用现有用户名或 admin）：', { required: false });
					const password = configuredSecret(env, 'MAINTENANCE_ADMIN_PASSWORD');
					if (!await confirmRescue(ask, '将恢复 base_users.id=1 的管理员状态；若记录不存在则使用提供的信息重建，确认继续？')) return '已取消';
					return runRescueAction('restore-admin', { user_name: userName, password });
				},
			},
			{
				key: 'set-admin-user-name',
				label: '设置基础管理员用户名',
				description: '只修改 base_users.id=1 的用户名',
				run: async ({ ask } = {}) => {
					const userName = await askValue(ask, env, 'MAINTENANCE_ADMIN_USER_NAME', '请输入新的管理员用户名：');
					if (!await confirmRescue(ask, `将把 base_users.id=1 的用户名设置为“${userName}”，确认继续？`)) return '已取消';
					return runRescueAction('set-admin-user-name', { user_name: userName });
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
				description: '只读取当前项目对应的 PM2 服务及 Cluster 实例',
				run: () => service.status({ projectDir, pmId: env.pm_id, appName: env.PM2_APP_NAME }),
			},
			{
				key: 'pm2-start',
				label: '启动服务（PM2 Cluster）',
				description: '自动注册当前项目并交给 PM2 Cluster 运行',
					run: async ({ ask } = {}) => {
						const name = await serviceName();
						const existing = await service.findOwn({ projectDir, pmId: env.pm_id, appName: env.PM2_APP_NAME });
						if (existing && existing.onlineCount === existing.instanceCount && existing.instanceCount > 0) return `PM2 服务“${describeTarget(existing)}”已经运行`;
					if (!await confirmTarget(ask, '启动', existing || { name, desiredInstances: env.PM2_INSTANCES || 'max' })) return '已取消';
						await beforePm2Start?.();
						const result = await service.start({ projectDir, appName: name, instances: env.PM2_INSTANCES || 'max' });
						await followOwnLogs();
						return result;
				},
			},
			{
				key: 'pm2-restart',
				label: '重启服务',
				description: '通过 PM2 重启当前项目的全部 Cluster 实例',
					run: async ({ ask } = {}) => {
						const target = await ownService();
						if (!await confirmTarget(ask, '重启', target)) return '已取消';
						const result = await service.restart(target);
						await followOwnLogs();
						return result;
				},
			},
			{
				key: 'pm2-scale',
				label: '调整 Cluster 实例数',
				description: '交互式调整当前项目的 PM2 实例数并保存配置',
				run: async ({ ask } = {}) => {
					const target = await ownService();
					const instances = await askInstanceCount(ask, env, service, target.instanceCount);
					const count = service.resolveInstanceCount(instances);
					if (count === target.instanceCount) return `Cluster 实例数未变化，仍为 ${count}`;
					if (!await confirmTarget(ask, '调整 Cluster 实例数', { ...target, desiredInstances: count })) return '已取消';
					const result = await service.scale(target, instances);
					await followOwnLogs();
					return result;
				},
			},
			{
				key: 'pm2-stop',
				label: '停止服务',
				description: '通过 PM2 停止当前项目的全部 Cluster 实例',
				run: async ({ ask } = {}) => {
					const target = await ownService();
					if (!await confirmTarget(ask, '停止', target)) return '已取消';
					const result = await service.stop(target);
					stopPm2Logs?.();
					return result;
				},
			},
			{
				key: 'pm2-logs',
				label: '查看服务日志',
				description: `显示当前项目全部 Cluster 实例最近 ${DEFAULT_LOG_LINES} 行日志`,
				run: async () => service.logs(await ownService(), DEFAULT_LOG_LINES),
			},
		],
	}],
};
};

module.exports = { createMaintenanceActions };
