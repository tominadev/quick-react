const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_LOG_LINES = 50;
const APP_NAME_PATTERN = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,127}$/;
const PM2_INSTALL_COMMAND = 'npm install -g pm2';
/**
 * 必须以「未找到 pm2」开头：detect() 靠这个前缀区分「没装」和「装了但出错」。
 * 带上安装命令是因为这条消息出现的场合——启动服务、开发启动器自检——正是需要立刻
 * 把 PM2 装上的时候，只说「请先安装」等于还要再查一次文档。
 */
const PM2_MISSING_MESSAGE = `未找到 pm2，请先安装 PM2：${PM2_INSTALL_COMMAND}（已安装则确认 pm2 在当前 PATH 中）`;

/**
 * 开机自启由 PM2 写一个 systemd 单元（pm2-<系统用户>.service）实现，
 * 单元只负责在开机时拉起 PM2 daemon 并 resurrect 已保存的进程清单，
 * 因此它和「服务注册」是两件事：服务注册在 PM2 的进程列表里，开机自启在 systemd 里。
 */
const STARTUP_INIT_SYSTEM = 'systemd';
const systemdAvailable = () => fs.existsSync('/run/systemd/system');
const startupUser = () => {
	try { return os.userInfo().username; }
	catch { return toText(process.env.USER) || 'root'; }
};
const startupUnitPath = (user) => path.join('/etc/systemd/system', `pm2-${user}.service`);
const runningAsRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const startupCommand = (verb, user, home) => `sudo env PATH=$PATH pm2 ${verb} ${STARTUP_INIT_SYSTEM} -u ${user} --hp ${home}`;

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
		if (error.code === 'ENOENT') finish(reject, new Error(PM2_MISSING_MESSAGE));
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
	/**
	 * 取出 jlist 输出里的 JSON 数组。直接 JSON.parse 整段 stdout 在一种场合下必然失败：
	 * PM2 daemon 还没起来时，第一条 pm2 命令会顺带把 daemon 拉起来，并把那张 ASCII banner
	 * 和「Spawning PM2 daemon」一起打到 stdout，JSON 前面就多了一大段说明文字。
	 * 这正是刚装完 PM2、第一次打开工具箱时的状态。
	 */
	const extractJsonList = (stdout) => {
		const raw = toText(stdout);
		if (!raw) return '[]';
		const end = raw.lastIndexOf(']');
		if (end === -1) return raw;  // 让下面的 JSON.parse 抛出统一的错误
		// 不能取第一个 '['：banner 里的 "[PM2] Spawning PM2 daemon" 也是方括号开头。
		// 从最后一个 '[' 往前逐个试，能解析成数组的那个才是 jlist 的输出。
		let start = raw.lastIndexOf('[', end);
		while (start !== -1) {
			const candidate = raw.slice(start, end + 1);
			try {
				if (Array.isArray(JSON.parse(candidate))) return candidate;
			} catch {
				// 这个 '[' 不是数组开头，继续往前找
			}
			if (start === 0) break;
			start = raw.lastIndexOf('[', start - 1);
		}
		return raw;
	};
	const readProcesses = async () => {
		const result = await execute(['jlist']);
		try {
			const processes = JSON.parse(extractJsonList(result.stdout));
			if (!Array.isArray(processes)) throw new Error('PM2 返回的进程列表不是数组');
			return processes;
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error(`PM2 返回的进程列表不是有效 JSON：${result.output || '无输出'}`);
			throw error;
		}
	};
	const sameProject = (process, projectPath) => {
		if (!projectPath) return false;
		const cwd = toText(process.pm2_env?.cwd);
		if (!cwd) return false;
		try { return fs.realpathSync(cwd).toLowerCase() === projectPath.toLowerCase(); }
		catch { return path.resolve(cwd).toLowerCase() === projectPath.toLowerCase(); }
	};
	const toProjectPath = (value) => {
		try { return value ? fs.realpathSync(path.resolve(value)) : ''; }
		catch { return value ? path.resolve(value) : ''; }
	};
	const createTarget = (processes, allProcesses) => {
		const name = validateAppName(String(processes[0]?.name ?? ''));
		const instanceIds = processes.map((process) => process.pm_id).filter((id) => id !== undefined && id !== null);
		const statuses = processes.map((process) => String(process.pm2_env?.status ?? 'unknown'));
		const onlineCount = statuses.filter((status) => status === 'online').length;
		const status = statuses.every((value) => value === statuses[0]) ? statuses[0] : 'mixed';
		const uptimeValues = processes.map((process) => Number(process.pm2_env?.pm_uptime)).filter((value) => Number.isFinite(value) && value > 0);
		return {
			name,
			status,
			instanceIds,
			instanceCount: processes.length,
			onlineCount,
			pm_uptime: uptimeValues.length ? Math.min(...uptimeValues) : undefined,
			nameCollision: allProcesses.filter((process) => String(process.name ?? '') === name).length !== processes.length,
		};
	};
	const targetArgs = (target) => {
		if (!target || typeof target !== 'object' || !Array.isArray(target.instanceIds) || !target.instanceIds.length) throw new Error('当前项目未找到可操作的 PM2 服务');
		if (target.nameCollision) throw new Error(`PM2 中存在其他目录的同名服务“${target.name}”，为避免误操作已拒绝服务控制`);
		const ids = target.instanceIds.map((id) => String(id));
		if (ids.some((id) => !/^\d+$/.test(id))) throw new Error('PM2 服务实例标识无效，已拒绝服务控制');
		return ids;
	};
	const resolveProjectPath = (projectDir) => {
		const projectPath = toProjectPath(projectDir);
		if (!projectPath) throw new Error('缺少当前项目目录，无法注册 PM2 服务');
		return projectPath;
	};
	const resolveAppName = ({ projectDir = '', appName = '' } = {}) => {
		if (appName) return validateAppName(appName);
		const projectPath = resolveProjectPath(projectDir);
		let packageName = '';
		try {
			const packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
			packageName = toText(packageJson.name);
		} catch {
			// A package name is convenient but not required; use the project directory below.
		}
		const fallback = packageName || path.basename(projectPath);
		return validateAppName(fallback.replace(/[^A-Za-z0-9_.:-]/g, '-'));
	};
	const validateInstances = (value) => {
		const instances = toText(value || 'max');
		if (instances === 'max') return instances;
		if (!/^\d+$/.test(instances) || Number(instances) < 1 || Number(instances) > 256) {
			throw new Error('PM2 Cluster 实例数必须是 max 或 1 到 256 的整数');
		}
		return instances;
	};
	const cpuInstances = () => {
		try {
			const count = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
			return Math.max(1, Number(count) || 1);
		} catch {
			return 1;
		}
	};
	const numericInstances = (value) => {
		const instances = validateInstances(value);
		return instances === 'max' ? cpuInstances() : Number(instances);
	};
	return {
		async detect({ projectDir = '', appName = '' } = {}) {
			try {
				const own = await this.findOwn({ projectDir, appName });
				return { installed: true, running: Boolean(own && own.onlineCount > 0) };
			} catch (error) {
				if (error instanceof Error && error.message.startsWith('未找到 pm2')) return { installed: false, running: false, error: error.message };
				return { installed: true, running: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		async findOwn({ projectDir = '', pmId = '', appName = '' } = {}) {
			const processes = await readProcesses();
			const projectPath = toProjectPath(projectDir);
			const currentProcessId = toText(pmId);
			const configuredName = appName ? validateAppName(appName) : '';
			if (currentProcessId) {
				const current = processes.find((process) => toText(process.pm_id) === currentProcessId);
				if (!current) return null;
				const currentPath = toProjectPath(current.pm2_env?.cwd);
				return createTarget(processes.filter((process) => String(process.name ?? '') === String(current.name ?? '') && sameProject(process, currentPath)), processes);
			}
			const candidates = processes.filter((process) => sameProject(process, projectPath) && (!configuredName || String(process.name ?? '') === configuredName));
			if (!candidates.length) return null;
			const names = [...new Set(candidates.map((process) => String(process.name ?? '')))];
			if (names.length > 1) throw new Error('当前项目对应多个 PM2 服务，请通过 PM2_APP_NAME 明确指定');
			return createTarget(candidates, processes);
		},
		async status(options = {}) {
			const process = await this.findOwn(options);
			if (!process) return '当前项目未注册 PM2 服务，未读取或操作其他应用';
			const uptime = Number(process.pm_uptime);
			const uptimeText = Number.isFinite(uptime) && uptime > 0 ? `，启动于 ${new Date(uptime).toISOString()}` : '';
			return `${process.name}：${process.status}，实例 ${process.onlineCount}/${process.instanceCount} 在线，pm_id=${process.instanceIds.join('、') || '未知'}${uptimeText}`;
		},
		async resolveName(options = {}) {
			return resolveAppName(options);
		},
		normalizeInstances(value) {
			return validateInstances(value);
		},
		resolveInstanceCount(value) {
			return numericInstances(value);
		},
		async start({ projectDir = '', appName = '', instances = 'max' } = {}) {
			const projectPath = resolveProjectPath(projectDir);
			const name = resolveAppName({ projectDir: projectPath, appName });
			const count = validateInstances(instances);
			const script = path.join(projectPath, 'dist', 'server.mjs');
			if (!fs.existsSync(script)) throw new Error(`未找到 ${script}，请先完成构建后再启动 PM2 服务`);
			const processes = await readProcesses();
			const sameName = processes.filter((process) => String(process.name ?? '') === name);
			const own = await this.findOwn({ projectDir: projectPath, appName: name });
			if (own) {
				const ids = targetArgs(own);
				if (own.onlineCount === own.instanceCount && own.instanceCount > 0) return `PM2 服务“${name}”已经运行（${own.instanceCount} 个 Cluster 实例）`;
				const outputs = [];
				for (const id of ids) outputs.push((await execute(['start', id])).output);
				await execute(['save']);
				return outputs.filter(Boolean).join('\n') || `PM2 已启动 ${name} 的 ${ids.length} 个 Cluster 实例`;
			}
			if (sameName.length) throw new Error(`PM2 中已有其他目录的同名服务“${name}”，为避免误操作请设置 PM2_APP_NAME 后重试`);
			const result = await execute([
				'start', script,
				'--name', name,
				'--cwd', projectPath,
				'--instances', count,
			]);
			await execute(['save']);
			return result.output || `PM2 已注册并启动 ${name}（Cluster：${count}）`;
		},
		async restart(target) {
			const ids = targetArgs(target);
			const outputs = [];
			for (const id of ids) outputs.push((await execute(['restart', id])).output);
			return outputs.filter(Boolean).join('\n') || `PM2 已请求重启 ${target.name} 的 ${ids.length} 个实例`;
		},
		async stop(target) {
			const ids = targetArgs(target);
			const outputs = [];
			for (const id of ids) outputs.push((await execute(['stop', id])).output);
			return outputs.filter(Boolean).join('\n') || `PM2 已请求停止 ${target.name} 的 ${ids.length} 个实例`;
		},
		/**
		 * 卸载与停止的区别：停止只把实例置为 stopped，注册还在，开机自启和 pm2 resurrect
		 * 仍会把它拉起来；卸载要连注册一起删掉，所以删完必须 save 覆盖已保存的进程清单，
		 * 否则下次开机它又回来了。
		 */
		async uninstall(target) {
			const ids = targetArgs(target);
			const outputs = [];
			for (const id of ids) outputs.push((await execute(['delete', id])).output);
			await execute(['save']);
			return outputs.filter(Boolean).join('\n') || `PM2 已卸载 ${target.name} 的 ${ids.length} 个实例`;
		},
		/**
		 * 开机自启的状态只看 systemd 单元在不在，不去问 PM2：PM2 自己不记录
		 * 「是否注册过 startup」，问它只能拿到一段提示文案。
		 */
		async startupStatus() {
			const user = startupUser();
			const unit = startupUnitPath(user);
			if (!systemdAvailable()) {
				return { supported: false, enabled: false, user, unit, message: '当前系统没有 systemd，无法由工具箱配置开机自启' };
			}
			const enabled = fs.existsSync(unit);
			return {
				supported: true,
				enabled,
				user,
				unit,
				message: enabled ? `已注册（${unit}）` : '未注册，机器重启后 PM2 不会自动拉起服务',
			};
		},
		async enableStartup() {
			const status = await this.startupStatus();
			if (!status.supported) throw new Error(status.message);
			if (status.enabled) return `PM2 开机自启已注册：${status.unit}`;
			// 写 /etc/systemd/system 需要 root；这里不代为 sudo，避免在管道里卡在密码提示上。
			if (!runningAsRoot()) throw new Error(`注册开机自启需要 root 权限，请用管理员执行：${startupCommand('startup', status.user, os.homedir())}`);
			const result = await execute(['startup', STARTUP_INIT_SYSTEM, '-u', status.user, '--hp', os.homedir()], { timeoutMs: 60_000 });
			// 开机时恢复的是 save 过的进程清单，没 save 过就等于开机自启一个空列表。
			await execute(['save']);
			return result.output || `PM2 开机自启已注册：${status.unit}`;
		},
		async disableStartup() {
			const status = await this.startupStatus();
			if (!status.supported) throw new Error(status.message);
			if (!status.enabled) return 'PM2 开机自启本来就没有注册';
			if (!runningAsRoot()) throw new Error(`取消开机自启需要 root 权限，请用管理员执行：${startupCommand('unstartup', status.user, os.homedir())}`);
			const result = await execute(['unstartup', STARTUP_INIT_SYSTEM, '-u', status.user, '--hp', os.homedir()], { timeoutMs: 60_000 });
			return result.output || `PM2 开机自启已取消：${status.unit}`;
		},
		async scale(target, instances) {
			targetArgs(target);
			const count = numericInstances(instances);
			const result = await execute(['scale', target.name, String(count)]);
			await execute(['save']);
			return result.output || `PM2 已将 ${target.name} 调整为 ${count} 个 Cluster 实例`;
		},
		async logs(target, lines = DEFAULT_LOG_LINES) {
			const ids = targetArgs(target);
			const count = Number(lines);
			if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('日志行数必须是 1 到 200 的整数');
			const outputs = [];
			for (const id of ids) outputs.push((await execute(['logs', id, '--nostream', '--lines', String(count)]).catch((error) => ({ output: `实例 ${id} 日志读取失败：${error instanceof Error ? error.message : String(error)}` }))).output);
			return outputs.filter(Boolean).join('\n') || `PM2 没有返回 ${target.name} 的日志`;
		},
		followLogs(target, { lines = DEFAULT_LOG_LINES, onStdout, onStderr } = {}) {
			const ids = targetArgs(target);
			const count = Number(lines);
			if (!Number.isInteger(count) || count < 0 || count > 200) throw new Error('日志行数必须是 0 到 200 的整数');
			const child = spawn('pm2', ['logs', ...ids, '--lines', String(count)], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout.on('data', (chunk) => onStdout?.(chunk));
			child.stderr.on('data', (chunk) => onStderr?.(chunk));
			child.once('error', (error) => onStderr?.(`${error instanceof Error ? error.message : String(error)}\n`));
			return { child, stop: () => { if (!child.killed) child.kill('SIGTERM'); } };
		},
	};
};

module.exports = { createPm2Service, validateAppName, DEFAULT_LOG_LINES, PM2_INSTALL_COMMAND, PM2_MISSING_MESSAGE };
