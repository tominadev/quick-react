const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const { generate: generateWorkerRegistryFile } = require('./scripts/generate-worker-registry.cjs');
const { createMaintenanceToolbox, createOutputGate } = require('./scripts/maintenance-toolbox.cjs');
const { createMaintenanceActions } = require('./scripts/maintenance-actions.cjs');
const { createPm2Service, PM2_INSTALL_COMMAND } = require('./scripts/maintenance-service-pm2.cjs');

const projectDir = __dirname;
const distDir = path.join(projectDir, 'dist');
const publicDir = path.join(projectDir, 'public');

const verifyPrismaMigrations = () => {
	const result = spawnSync(process.execPath, [path.join(projectDir, 'scripts', 'verify-prisma-migrations.mjs')], {
		cwd: projectDir,
		stdio: 'inherit',
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error('Prisma Schema 校验失败，已停止构建');
};

const createRuntimeConfig = () => {
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(
		path.join(distDir, 'runtime-config.mjs'),
		`export default ${JSON.stringify({})};\n`,
	);
};

const createBuildContext = async (entryPoint, outputDir, outfile, options = {}, onBuild) => {
	let initialBuildResolve;
	let initialBuildReject;
	let initialBuildCompleted = false;
	const initialBuild = new Promise((resolve, reject) => {
		initialBuildResolve = resolve;
		initialBuildReject = reject;
	});
	const context = await esbuild.context({
		entryPoints: [path.join(projectDir, entryPoint)],
		bundle: true,
		sourcemap: true,
		outfile: path.join(outputDir, outfile),
		plugins: [{
			name: `rebuild-notify-${outfile}`,
			setup(build) {
				build.onEnd((result) => {
					console.log(`${outfile}: build ended with ${result.errors.length} errors`);
					if (result.errors.length === 0) onBuild?.();
					if (!initialBuildCompleted) {
						initialBuildCompleted = true;
						if (result.errors.length > 0) {
							initialBuildReject(new Error(`${outfile} initial build failed`));
						} else {
							initialBuildResolve();
						}
					}
				});
			},
		}],
		...options,
	});
	return { context, initialBuild };
};

const main = async () => {
	verifyPrismaMigrations();
	const watch = process.argv.includes('--watch');
	const startServer = process.argv.includes('--start') || process.env.START_SERVER === '1';
	const restartServer = process.argv.includes('--restart') || process.env.AUTO_RESTART_SERVER === '1';
	const noToolbox = process.argv.includes('--no-toolbox');
	const toolboxRequested = process.argv.includes('--toolbox') && !noToolbox;
	const toolboxEnabled = !noToolbox && (toolboxRequested || (startServer && Boolean(process.stdin.isTTY && process.stdout.isTTY)));
	let noListen = process.argv.includes('--no-listen') || process.env.DEV_NO_LISTEN === '1';
	const noStartupChecks = process.argv.includes('--no-checks') || process.env.DEV_NO_CHECKS === '1';
	const pm2Service = createPm2Service();
	if (noListen) process.env.SKIP_SERVER_LISTEN = '1';
	if (noStartupChecks) process.env.SKIP_STARTUP_CHECKS = '1';
	let serverProcess;
	let externalPm2Target;
	let pm2LogFollower;
	const followPm2Logs = async (target) => {
		externalPm2Target = target;
		pm2LogFollower?.stop();
		const follower = pm2Service.followLogs(target, {
			onStdout: (chunk) => outputGate.writeStdout(chunk),
			onStderr: (chunk) => outputGate.writeStderr(chunk),
		});
		pm2LogFollower = follower;
		follower.child.once('close', () => {
			if (pm2LogFollower === follower) pm2LogFollower = undefined;
		});
	};
	const stopPm2Logs = () => {
		pm2LogFollower?.stop();
		pm2LogFollower = undefined;
		externalPm2Target = undefined;
	};
	let watchReady = false;
	let restartPromise = Promise.resolve();
	const outputGate = createOutputGate();
	if (toolboxEnabled) outputGate.installConsole();
	const pm2Managed = process.env.pm_id !== undefined;
	if (startServer && !noListen && pm2Managed && process.env.DEV_FORCE_LISTEN !== '1') {
		noListen = true;
		process.env.SKIP_SERVER_LISTEN = '1';
		console.warn('检测到当前 npm run dev 由 PM2 托管，将只构建和监听文件变化，不再监听 HTTP 端口。');
	} else if (startServer && !noListen && process.env.DEV_FORCE_LISTEN !== '1') {
		const pm2State = await pm2Service.detect({ projectDir });
		if (pm2State.running) {
			externalPm2Target = await pm2Service.findOwn({ projectDir });
			noListen = true;
			process.env.SKIP_SERVER_LISTEN = '1';
			console.warn('检测到同一项目已有在线 PM2 服务，npm run dev 将只构建和监听文件变化，不再监听 HTTP 端口。');
			if (externalPm2Target) await followPm2Logs(externalPm2Target);
		} else if (!pm2State.installed) {
			console.warn(`未检测到 PM2，保留当前监听设置；服务控制菜单需要先安装 PM2：${PM2_INSTALL_COMMAND}`);
		} else if (pm2State.error && pm2State.installed) {
			console.warn(`PM2 状态检测失败，保留当前监听设置：${pm2State.error}`);
		}
	}
	const launchServer = () => {
		const childEnv = { ...process.env };
		if (noListen) childEnv.SKIP_SERVER_LISTEN = '1';
		if (noStartupChecks) childEnv.SKIP_STARTUP_CHECKS = '1';
		serverProcess = spawn(process.execPath, [path.join(distDir, 'server.mjs')], {
			cwd: projectDir,
			env: childEnv,
			stdio: toolboxEnabled ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		});
		if (toolboxEnabled) {
			serverProcess.stdout?.on('data', (chunk) => outputGate.writeStdout(chunk));
			serverProcess.stderr?.on('data', (chunk) => outputGate.writeStderr(chunk));
		}
	};
	const stopLocalServer = async () => {
		if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) return;
		const current = serverProcess;
		current.kill('SIGTERM');
		await new Promise((resolve) => current.once('exit', resolve));
		if (serverProcess === current) serverProcess = undefined;
	};
	const restartRunningServer = () => {
		restartPromise = restartPromise.then(async () => {
			if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
				const oldProcess = serverProcess;
				oldProcess.kill('SIGTERM');
				await new Promise((resolve) => oldProcess.once('exit', resolve));
			}
			launchServer();
		});
	};
	const restartRunningPm2 = () => {
		restartPromise = restartPromise.then(async () => {
			const target = await pm2Service.findOwn({ projectDir });
			if (!target) {
				console.warn('PM2 服务已不再存在，跳过开发重启；可在维护工具箱中重新启动服务。');
				return;
			}
			externalPm2Target = target;
			await pm2Service.restart(target);
			await followPm2Logs(target);
		});
	};
	const handleBackendBuild = () => {
		if (!watchReady) return;
		if (externalPm2Target) restartRunningPm2();
		else if (!noListen) restartRunningServer();
	};
	const maintenanceActions = toolboxEnabled ? createMaintenanceActions({
		service: pm2Service,
		env: process.env,
		projectDir,
		beforePm2Start: stopLocalServer,
		followPm2Logs,
		stopPm2Logs,
	}) : undefined;
	const toolbox = toolboxEnabled ? createMaintenanceToolbox({
		groups: maintenanceActions.groups,
		title: '维护工具箱',
		outputGate,
	}) : undefined;
	if (toolbox) {
		process.once('exit', () => { stopPm2Logs(); toolbox.close(); });
		toolbox.attach();
	}
	generateWorkerRegistryFile();
	/**
	 * 每套前端一个产物。清单在 `shared/web-clients.mts`，域名按 `client_key` 选用哪一个——
	 * 两处必须对得上，由 `test:web-clients` 守住：清单里有而这里没建，那个域名会去请求一个
	 * 404 的脚本，页面停在加载动画上。
	 */
	const webClients = [
		{ entry: 'clients/antd/index.tsx', bundle: 'bundle.js' },
		{ entry: 'clients/antd-mobile/index.tsx', bundle: 'bundle-antd-mobile.js' },
	];
	const frontends = [];
	for (const client of webClients) {
		frontends.push(await createBuildContext(client.entry, publicDir, client.bundle, { minify: true }));
	}
	const passportSdk = await createBuildContext('clients/passport/index.ts', publicDir, 'passport.js', {
		bundle: true,
		format: 'iife',
		minify: true,
	});
	const backend = await createBuildContext('server/app.mts', distDir, 'server.mjs', {
		platform: 'node',
		format: 'esm',
		target: 'node18',
		packages: 'external',
	}, watch && startServer && restartServer ? handleBackendBuild : undefined);
	const worker = await createBuildContext('server/worker.mts', distDir, 'worker.mjs', {
		platform: 'neutral',
		format: 'esm',
		target: 'es2022',
	});
	const builds = [...frontends, passportSdk, backend, worker];
	const contexts = builds.map(({ context }) => context);
	if (watch) {
		await Promise.all(contexts.map((context) => context.watch()));
		await Promise.all(builds.map(({ initialBuild }) => initialBuild));
		createRuntimeConfig();
		watchReady = true;
		console.log('Watching frontend and backend sources');
	} else {
		try {
			await Promise.all(contexts.map((context) => context.rebuild()));
		} finally {
			await Promise.all(contexts.map((context) => context.dispose()));
		}
		createRuntimeConfig();
	}

	let requestedToolbox;
	if (startServer) {
		if (watch && (restartServer || toolboxEnabled) && !noListen) {
			const stopServer = () => {
				if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
			};
			process.once('exit', stopServer);
			process.once('SIGINT', stopServer);
			process.once('SIGTERM', stopServer);
			launchServer();
			if (toolbox && toolboxRequested) requestedToolbox = toolbox.open();
			await new Promise((resolve, reject) => {
				serverProcess.once('error', reject);
				serverProcess.once('exit', (code, signal) => {
					if (code && code !== 0) reject(new Error(`Server exited with code ${code}`));
					else if (signal !== 'SIGTERM') reject(new Error(`Server exited with signal ${signal}`));
					else resolve();
				});
			});
		} else if (!noListen) {
			const serverImport = import(`${pathToFileURL(path.join(distDir, 'server.mjs')).href}?startup=${Date.now()}`);
			if (toolbox && toolboxRequested) requestedToolbox = toolbox.open();
			await serverImport;
		} else {
			// Another supervisor (normally PM2 Cluster) owns the HTTP listener. Keep
			// the watcher/toolbox process alive without importing a second listener.
			if (toolbox && toolboxRequested) requestedToolbox = toolbox.open();
			await new Promise(() => {});
		}
	} else if (toolbox && toolboxRequested) {
		requestedToolbox = toolbox.open();
	}
	if (requestedToolbox) await requestedToolbox;
};

main().catch((error) => {
	// Bypass the menu output gate for a fatal startup error; otherwise entering
	// the toolbox just before a failed build could hide the only useful cause.
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exitCode = 1;
});
