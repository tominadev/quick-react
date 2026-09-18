import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * 把 package.json 里所有 `test:*` 跑一遍。
 *
 * 在这之前每条测试都得自己敲一次名字，于是「哪几条正在挂」这件事没有任何人知道——
 * 三条浏览器测试挂了很久才被发现，其中一条挂的方式还是被内核 SIGKILL。清单从
 * package.json 现读，新加一条测试不必回来登记，漏跑也就无从发生。
 *
 * 串行跑：测试之间共用临时数据库文件和端口，并行会互相踩。
 */
const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const names = Object.keys(scripts).filter((name) => name.startsWith('test:') && name !== 'test:all');

const run = (name) => new Promise((resolve) => {
	const child = spawn('npm', ['run', '--silent', name], { stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });
	child.on('close', (code, signal) => resolve({ code, signal, output }));
});

const failures = [];
for (const [index, name] of names.entries()) {
	const started = Date.now();
	const { code, signal, output } = await run(name);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (code === 0) {
		console.log(`[${index + 1}/${names.length}] ✓ ${name}  ${seconds}s`);
		continue;
	}
	// 被信号打死的（内存失控就是这样）只有退出码，正文里一个字都没有，得说明白。
	const how = signal ? `被 ${signal} 打死` : `退出码 ${code}`;
	console.log(`[${index + 1}/${names.length}] ✗ ${name}  ${seconds}s  ${how}`);
	failures.push({ name, how, output });
}

if (!failures.length) {
	console.log(`\n${names.length} 条测试全部通过`);
	process.exit(0);
}
for (const failure of failures) {
	console.log(`\n===== ${failure.name}（${failure.how}）`);
	console.log(failure.output.split('\n').slice(-25).join('\n'));
}
console.log(`\n${failures.length}/${names.length} 条失败：${failures.map((item) => item.name).join(' ')}`);
process.exit(1);
