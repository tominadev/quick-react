const readline = require('node:readline');
const util = require('node:util');

const MAX_BUFFERED_LOGS = 200;

/**
 * Shared terminal output gate. The caller may use it for a dev process, while
 * the toolbox itself remains independent from esbuild and server lifecycle.
 */
const createOutputGate = ({ output = process.stdout, errorOutput = process.stderr, maxBufferedLogs = MAX_BUFFERED_LOGS } = {}) => {
	let muted = false;
	let installed = false;
	const buffered = [];
	const originals = new Map();
	const write = (stream, chunk) => {
		if (muted) {
			buffered.push({ stream, chunk: String(chunk) });
			if (buffered.length > maxBufferedLogs) buffered.splice(0, buffered.length - maxBufferedLogs);
			return;
		}
		(stream === 'stderr' ? errorOutput : output).write(chunk);
	};
	return {
		installConsole() {
			if (installed) return;
			installed = true;
			for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
				const original = console[method];
				originals.set(method, original);
				console[method] = (...args) => write(method === 'error' || method === 'warn' ? 'stderr' : 'stdout', `${util.format(...args)}\n`);
			}
		},
		restoreConsole() {
			if (!installed) return;
			for (const [method, original] of originals) console[method] = original;
			originals.clear();
			installed = false;
		},
		setMuted(value) { muted = Boolean(value); },
		writeStdout(chunk) { write('stdout', chunk); },
		writeStderr(chunk) { write('stderr', chunk); },
		drain() {
			const logs = buffered.splice(0);
			return logs;
		},
	};
};

const resultMessage = (result) => {
	if (result === undefined || result === null) return '操作完成';
	if (typeof result === 'string') return result;
	if (typeof result === 'object' && typeof result.message === 'string') return result.message;
	return util.inspect(result, { depth: 4, colors: false });
};

/**
 * Independent interactive toolbox. Actions are injected by the caller, so
 * neither dev lifecycle code nor rescue business rules are embedded here.
 */
const createMaintenanceToolbox = ({
	input = process.stdin,
	output = process.stdout,
	outputGate = createOutputGate({ output, errorOutput: process.stderr }),
	actions = [],
	title = '维护工具箱',
	hotkey = 'm',
} = {}) => {
	let keypressListener;
	let rawModeBeforeAttach = false;
	let menuPromise;
	let menuOpen = false;
	const listActions = () => actions.filter((action) => action && action.key && action.label && typeof action.run === 'function');
	const write = (message = '') => output.write(`${message}${message.endsWith('\n') ? '' : '\n'}`);
	const restoreInput = () => {
		if (keypressListener) input.off('keypress', keypressListener);
		keypressListener = undefined;
		if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(rawModeBeforeAttach);
	};
	const attach = () => {
		if (keypressListener || !input.isTTY || !output.isTTY) return false;
		readline.emitKeypressEvents(input);
		rawModeBeforeAttach = Boolean(input.isRaw);
		input.setRawMode?.(true);
		input.resume?.();
		keypressListener = (_character, key = {}) => {
			if (key.ctrl && key.name === 'c') {
				restoreInput();
				outputGate.restoreConsole();
				process.exit(130);
			}
			if (!menuOpen && key.name === hotkey) void open();
		};
		input.on('keypress', keypressListener);
		write(`工具箱已就绪：按 ${hotkey} 打开，Ctrl+C 退出当前进程`);
		return true;
	};
	const runAction = async (action, ask) => {
		if (action.confirm) {
			const answer = await ask(`${action.confirm}\n请输入 yes 确认：`);
			if (String(answer).trim().toLowerCase() !== 'yes') return '已取消';
		}
		return resultMessage(await action.run());
	};
	const open = async () => {
		if (menuPromise) return menuPromise;
		menuPromise = (async () => {
			menuOpen = true;
			outputGate.setMuted(true);
			restoreInput();
			const terminal = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
			const queue = [];
			let waiter;
			let inputClosed = false;
			const onLine = (line) => {
				if (waiter) {
					const resolve = waiter;
					waiter = undefined;
					resolve(line);
				} else queue.push(line);
			};
			const onClose = () => {
				inputClosed = true;
				waiter?.('0');
				waiter = undefined;
			};
			const onSigint = () => {
				terminal.close();
				outputGate.setMuted(false);
				outputGate.restoreConsole();
				process.exit(130);
			};
			terminal.on('line', onLine);
			terminal.once('close', onClose);
			terminal.once('SIGINT', onSigint);
			const ask = (prompt) => {
				write(prompt);
				if (queue.length) return Promise.resolve(queue.shift());
				if (inputClosed) return Promise.resolve('0');
				return new Promise((resolve) => { waiter = resolve; });
			};
			try {
				while (true) {
					write(`\n${title}`);
					listActions().forEach((action, index) => write(`${index + 1}) ${action.label}${action.description ? ` — ${action.description}` : ''}`));
					write('0) 返回调用方');
					const choice = String(await ask('请选择：')).trim();
					if (choice === '0' || choice.toLowerCase() === 'q') break;
					const action = listActions()[Number(choice) - 1];
					if (!action) {
						write('请选择菜单中的编号');
						continue;
					}
					try { write(await runAction(action, ask)); }
					catch (error) { write(`操作失败：${error instanceof Error ? error.message : String(error)}`); }
				}
			} finally {
				terminal.off('line', onLine);
				terminal.off('close', onClose);
				terminal.off('SIGINT', onSigint);
				terminal.close();
				menuOpen = false;
				outputGate.setMuted(false);
				attach();
			}
		})();
		try { await menuPromise; } finally { menuPromise = undefined; }
	};
	const close = () => {
		restoreInput();
		outputGate.setMuted(false);
		outputGate.restoreConsole();
	};
	return { attach, open, close, get isOpen() { return menuOpen; }, outputGate };
};

module.exports = { createMaintenanceToolbox, createOutputGate };
