const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG_LINES = 50;
const APP_NAME_PATTERN = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,127}$/;

const toText = (value) => String(value ?? '').trim();

const validateAppName = (value) => {
	const appName = toText(value);
	if (!appName || !APP_NAME_PATTERN.test(appName)) {
		throw new Error('PM2 应用名无效，只允许 1 到 128 位字母、数字、点、下划线、冒号和短横线');
	}
	return appName;
};

const runPm2 = (args, { timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
	const child = spawn('pm2', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	let settled = false;
	const finish = (callback, value) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		callback(value);
	};
	const timer = setTimeout(() => {
		child.kill('SIGTERM');
		finish(reject, new Error(`PM2 命令超时：pm2 ${args.join(' ')}`));
	}, timeoutMs);
	child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
	child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
	child.once('error', (error) => {
		if (error.code === 'ENOENT') finish(reject, new Error('未找到 pm2，请先安装 PM2 或配置 PM2 可执行文件路径'));
		else finish(reject, error);
	});
	child.once('close', (code, signal) => {
		const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
		if (code === 0) finish(resolve, { stdout: stdout.trim(), stderr: stderr.trim(), output });
		else finish(reject, new Error(output || `PM2 命令失败（退出码 ${code ?? `信号 ${signal ?? 'unknown'}`}）`));
	});
});

const createPm2Service = () => {
	const execute = (args, options) => runPm2(args, options);
	return {
		async detect({ projectDir = '', appName = '' } = {}) {
			try {
				const result = await execute(['jlist']);
				let processes;
				try { processes = JSON.parse(result.stdout || '[]'); }
				catch { return { installed: true, running: false, error: 'PM2 返回的进程列表不是有效 JSON' }; }
				const targetName = appName ? validateAppName(appName) : '';
				let projectPath = '';
				try { projectPath = projectDir ? fs.realpathSync(path.resolve(projectDir)) : ''; }
				catch { projectPath = path.resolve(projectDir); }
				const running = Array.isArray(processes) && processes.some((process) => {
					const env = process.pm2_env ?? {};
					if (env.status !== 'online') return false;
					if (targetName) return String(process.name ?? '') === targetName;
					if (!projectPath) return false;
					try { return fs.realpathSync(String(env.cwd ?? '')).toLowerCase() === projectPath.toLowerCase(); }
					catch { return path.resolve(String(env.cwd ?? '')).toLowerCase() === projectPath.toLowerCase(); }
				});
				return { installed: true, running };
			} catch (error) {
				if (error instanceof Error && error.message.startsWith('未找到 pm2')) return { installed: false, running: false, error: error.message };
				return { installed: true, running: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		async status() {
			const result = await execute(['jlist']);
			let processes;
			try { processes = JSON.parse(result.stdout || '[]'); }
			catch { throw new Error(`PM2 返回的进程列表不是有效 JSON：${result.output || '无输出'}`); }
			if (!Array.isArray(processes) || processes.length === 0) return 'PM2 当前没有运行中的应用';
			return processes.map((process) => {
				const env = process.pm2_env ?? {};
				const uptime = Number(env.pm_uptime);
				const uptimeText = Number.isFinite(uptime) && uptime > 0 ? `，启动于 ${new Date(uptime).toISOString()}` : '';
				return `${process.name ?? '(未命名)'}：${env.status ?? '未知'}，pm_id=${process.pm_id ?? '未知'}${uptimeText}`;
			}).join('\n');
		},
		async restart(appName) {
			const name = validateAppName(appName);
			const result = await execute(['restart', name]);
			return result.output || `PM2 已请求重启 ${name}`;
		},
		async stop(appName) {
			const name = validateAppName(appName);
			const result = await execute(['stop', name]);
			return result.output || `PM2 已请求停止 ${name}`;
		},
		async logs(appName, lines = DEFAULT_LOG_LINES) {
			const name = validateAppName(appName);
			const count = Number(lines);
			if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('日志行数必须是 1 到 200 的整数');
			const result = await execute(['logs', name, '--nostream', '--lines', String(count)]);
			return result.output || `PM2 没有返回 ${name} 的日志`;
		},
	};
};

module.exports = { createPm2Service, validateAppName, DEFAULT_LOG_LINES };
