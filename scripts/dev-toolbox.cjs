const readline = require('node:readline');
const util = require('node:util');

const MAX_BUFFERED_LOGS = 200;

/**
 * Route development output through one gate so an interactive menu remains
 * readable. The gate does not change output during normal development; while
 * the menu is open, output is retained for the explicit "查看开发日志" action.
 */
const createOutputGate = ({ output = process.stdout, errorOutput = process.stderr, maxBufferedLogs = MAX_BUFFERED_LOGS } = {}) => {
	let muted = false;
	let installed = false;
	const buffered = [];
	const originals = new Map();

	const appendBuffered = (stream, chunk) => {
		buffered.push({ stream, chunk: String(chunk) });
		if (buffered.length > maxBufferedLogs) buffered.splice(0, buffered.length - maxBufferedLogs);
	};
	const write = (stream, chunk) => {
		if (muted) {
			appendBuffered(stream, chunk);
			return;
		}
		(stream === 'stderr' ? errorOutput : output).write(chunk);
	};
	const installConsole = () => {
		if (installed) return;
		installed = true;
		for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
			const original = console[method];
			originals.set(method, original);
			console[method] = (...args) => write(method === 'error' || method === 'warn' ? 'stderr' : 'stdout', `${util.format(...args)}\n`);
		}
	};
	const restoreConsole = () => {
		if (!installed) return;
		for (const [method, original] of originals) console[method] = original;
		originals.clear();
		installed = false;
	};
	return {
		installConsole,
		restoreConsole,
		setMuted(value) { muted = Boolean(value); },
		get muted() { return muted; },
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

const createDevToolbox = ({
	input = process.stdin,
	output = process.stdout,
	errorOutput = process.stderr,
	outputGate = createOutputGate({ output, errorOutput }),
	actions = [],
	onClose,
	hotkey = 'm',
} = {}) => {
	let keypressListener;
	let rawModeBeforeAttach = false;
	let menuPromise;
	let menuOpen = false;
	const actionList = () => actions.filter((action) => action && action.key && action.label && typeof action.run === 'function');

	const write = (message = '') => output.write(`${message}${message.endsWith('\n') ? '' : '\n'}`);
	const restoreInput = () => {
		if (keypressListener) input.off('keypress', keypressListener);
		keypressListener = undefined;
		if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(rawModeBeforeAttach);
	};
	const attachInput = () => {
		if (keypressListener || !input.isTTY || !output.isTTY) return false;
		readline.emitKeypressEvents(input);
		rawModeBeforeAttach = Boolean(input.isRaw);
		input.setRawMode?.(true);
		// readline.close() pauses stdin. Resume it before listening for the next
		// hotkey, otherwise returning from the first menu can look like a frozen
		// development process.
		input.resume?.();
		keypressListener = (_character, key = {}) => {
			if (key.ctrl && key.name === 'c') {
				restoreInput();
				outputGate.restoreConsole();
				process.exit(130);
				return;
			}
			if (!menuOpen && key.name === hotkey) {
				void open().catch((error) => write(`工具箱错误：${error instanceof Error ? error.message : String(error)}`));
			}
		};
		input.on('keypress', keypressListener);
		write(`开发工具箱已就绪：按 ${hotkey} 打开，Ctrl+C 退出开发进程`);
		return true;
	};

	const runAction = async (action, ask) => {
		if (action.confirm) {
			const answer = await ask(`${action.confirm}\n请输入 yes 确认：`);
			if (String(answer).trim().toLowerCase() !== 'yes') {
				write('已取消');
				return;
			}
		}
		try {
			const result = await action.run();
			write(resultMessage(result));
		} catch (error) {
			write(`操作失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const open = async () => {
		if (menuPromise) return menuPromise;
		menuPromise = (async () => {
			menuOpen = true;
			outputGate.setMuted(true);
			restoreInput();
			const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
			const queuedLines = [];
			let lineWaiter;
			let inputClosed = false;
			const onLine = (line) => {
				if (lineWaiter) {
					const resolve = lineWaiter;
					lineWaiter = undefined;
					resolve(line);
				} else queuedLines.push(line);
			};
			const onInputClose = () => {
				inputClosed = true;
				lineWaiter?.('0');
				lineWaiter = undefined;
			};
			const onMenuSigint = () => {
				rl.close();
				outputGate.setMuted(false);
				outputGate.restoreConsole();
				process.exit(130);
			};
			rl.on('line', onLine);
			rl.once('close', onInputClose);
			rl.once('SIGINT', onMenuSigint);
			const ask = (prompt) => {
				write(prompt);
				if (queuedLines.length) return Promise.resolve(queuedLines.shift());
				if (inputClosed) return Promise.resolve('0');
				return new Promise((resolve) => { lineWaiter = resolve; });
			};
			try {
				while (true) {
					write('');
					write('开发工具箱');
					for (const [index, action] of actionList().entries()) write(`${index + 1}) ${action.label}${action.description ? ` — ${action.description}` : ''}`);
					write('0) 返回开发进程');
					const answer = await ask('请选择：');
					const choice = String(answer).trim();
					if (choice === '0' || choice.toLowerCase() === 'q') break;
					const index = Number(choice) - 1;
					const action = Number.isInteger(index) ? actionList()[index] : undefined;
					if (!action) {
						write('请选择菜单中的编号');
						continue;
					}
					await runAction(action, ask);
				}
			} finally {
				rl.off('line', onLine);
				rl.off('close', onInputClose);
				rl.off('SIGINT', onMenuSigint);
				rl.close();
				menuOpen = false;
				outputGate.setMuted(false);
				attachInput();
				onClose?.();
			}
		})();
		try {
			await menuPromise;
		} finally {
			menuPromise = undefined;
		}
	};

	const close = () => {
		restoreInput();
		outputGate.setMuted(false);
		outputGate.restoreConsole();
	};

	return {
		attach: attachInput,
		open,
		close,
		get isOpen() { return menuOpen; },
		get outputGate() { return outputGate; },
	};
};

module.exports = { createDevToolbox, createOutputGate };
