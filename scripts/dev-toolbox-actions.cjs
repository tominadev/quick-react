/**
 * Development-process actions kept separate from the generic menu. Rescue
 * database actions must not be added here; they belong to the maintenance
 * module and can be called by the standalone maintenance CLI.
 */
const createDevActions = ({
	watch,
	startServer,
	restartServer,
	noListen,
	noStartupChecks,
	getServerProcess,
	getServerStartedAt,
	restartRunningServer,
	outputGate,
} = {}) => [
	{
		key: 'status',
		label: '查看开发服务状态',
		description: '显示构建、监听和子进程状态',
		run: () => {
			const serverProcess = getServerProcess?.();
			const processState = serverProcess
				? `子进程 ${serverProcess.exitCode === null ? '运行中' : `已退出(${serverProcess.exitCode ?? 'signal'})`}`
				: (startServer ? '当前进程内运行' : '未启动');
			return [
				`watch: ${watch ? '启用' : '关闭'}`,
				`监听: ${noListen ? '已禁止' : '允许'}`,
				`启动检查: ${noStartupChecks ? '已跳过' : '启用'}`,
				`服务: ${processState}`,
				getServerStartedAt?.() ? `启动时间: ${new Date(getServerStartedAt()).toISOString()}` : '',
			].filter(Boolean).join('\n');
		},
	},
	{
		key: 'restart',
		label: '重启开发服务',
		description: '仅适用于 --restart 启动的子进程模式',
		confirm: '将终止当前开发服务并重新启动，确认继续？',
		run: async () => {
			if (!restartServer) throw new Error('当前不是子进程重启模式，请使用 npm run dev:restart');
			await restartRunningServer?.();
			return '开发服务已请求重启';
		},
	},
	{
		key: 'stop',
		label: '停止开发服务',
		description: '停止 --restart 模式的子进程',
		confirm: '将停止当前开发服务，确认继续？',
		run: () => {
			const serverProcess = getServerProcess?.();
			if (!serverProcess || serverProcess.exitCode !== null) return '当前没有可停止的子进程';
			serverProcess.kill('SIGTERM');
			return '已发送停止信号';
		},
	},
	{
		key: 'logs',
		label: '查看开发日志',
		description: '显示菜单打开期间暂存的日志',
		run: () => {
			const logs = outputGate?.drain() ?? [];
			return logs.length ? logs.map(({ stream, chunk }) => `[${stream}] ${chunk}`).join('') : '没有暂存的开发日志';
		},
	},
];

module.exports = { createDevActions };
