import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * 域名选前端。
 *
 * 清单（`shared/web-clients.mts`）、esbuild 的构建入口、以及页面壳引用的脚本三者必须
 * 对得上。**对不上的表现是白屏**：域名配了一套没构建出来的前端，浏览器去请求一个 404 的
 * 脚本，页面停在「正在加载页面…」上，而后台看着一切正常——只有访问那个域名的人才会遇到。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'quick-react-web-clients-'));
try {
	const result = await build({
		stdin: { contents: "export * from './shared/web-clients.mts';", resolveDir: projectDirectory, sourcefile: 'web-clients-entry.ts' },
		bundle: true, format: 'esm', platform: 'neutral', write: false,
	});
	const file = join(directory, 'web-clients.mjs');
	await writeFile(file, result.outputFiles[0].contents);
	const { WEB_CLIENTS, DEFAULT_WEB_CLIENT, webClientFor } = await import(pathToFileURL(file));

	// ---- 清单本身 ----
	assert.ok(WEB_CLIENTS.length >= 2, '至少要有电脑版与手机版两套');
	assert.equal(new Set(WEB_CLIENTS.map((client) => client.key)).size, WEB_CLIENTS.length, 'key 不能重复');
	assert.equal(new Set(WEB_CLIENTS.map((client) => client.bundle)).size, WEB_CLIENTS.length, '两套前端不能指向同一个产物');
	// 空串是「用默认那一套」的意思，不能被某一套占用——占用了就再也表达不出「默认」。
	assert.ok(!WEB_CLIENTS.some((client) => client.key === ''), 'key 不能是空串');

	// ---- 每个入口文件都要存在，每个产物都要有人构建 ----
	const esbuildSource = await readFile(resolve(projectDirectory, 'esbuild.cjs'), 'utf8');
	for (const client of WEB_CLIENTS) {
		await access(resolve(projectDirectory, client.entry));
		assert.ok(esbuildSource.includes(`'${client.entry}'`), `${client.key} 的入口没有在 esbuild.cjs 里构建：域名选了它就会白屏`);
		assert.ok(esbuildSource.includes(`'${client.bundle}'`), `${client.key} 的产物名没有在 esbuild.cjs 里出现`);
	}

	// ---- 认不出的 key 回落到默认，而不是报错或白屏 ----
	// 这一步一旦拿不到结果，整个域名就打不开——回落至少让人还能进后台把它改回来。
	assert.equal(webClientFor(undefined).key, DEFAULT_WEB_CLIENT.key);
	assert.equal(webClientFor('').key, DEFAULT_WEB_CLIENT.key);
	assert.equal(webClientFor('vue-does-not-exist').key, DEFAULT_WEB_CLIENT.key);
	assert.equal(webClientFor('antd-mobile').bundle, 'bundle-antd-mobile.js');

	// ---- 端到端：三个域名指向同一个站点，各出各的脚本 ----
	const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-web-clients-db-'));
	process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
	process.env.SKIP_SERVER_LISTEN = '1';
	try {
		const { app } = await import(`../dist/server.mjs?web-clients=${Date.now()}`);
		const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const now = Date.now();
		for (const [hostname, clientKey] of [['www.test', ''], ['m.test', 'antd-mobile'], ['stale.test', 'vue-does-not-exist']]) {
			database.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, client_key, status, created_at) VALUES (lower(hex(randomblob(16))), ?, 'global', ?, 'enabled', ?)").run(hostname, clientKey, now);
		}
		database.close();
		const scriptOf = async (hostname) => {
			const html = await (await app.request(`http://${hostname}/`, { headers: { accept: 'text/html' } })).text();
			return [...html.matchAll(/<script src="\/([^".]+\.js)/g)].map((match) => match[1])[0];
		};
		assert.equal(await scriptOf('www.test'), 'bundle.js', '没配就是默认那一套');
		assert.equal(await scriptOf('m.test'), 'bundle-antd-mobile.js', '同一个站点、同一批数据，只是 UI 不同');
		// 库里留着一个已经下线的 key 时不能白屏：那台机器上的人还得进后台去改它。
		assert.equal(await scriptOf('stale.test'), 'bundle.js', '认不出的 key 要回落，不能去请求一个 404 的脚本');
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}

	/**
	 * **共用的部分不许各写一份。**
	 *
	 * 请求层与表格协议在 `clients/browser/`，两套 UI 引同一份。各写一遍的话，同一个后端
	 * 会在两个前端上表现不同——`include` 算错就每次翻页重取一遍结构，`visibleWhen` 判错
	 * 就把「回滚」显示在一条已经回滚过的记录上。这种漂移在复制代码的那一刻看不出来。
	 */
	const mobileSources = await Promise.all(['App.tsx', 'common-api.tsx', 'components/MobileTable.tsx', 'components/MobileForm.tsx']
		.map((name) => readFile(resolve(projectDirectory, 'clients/antd-mobile', name), 'utf8')));
	const mobileAll = mobileSources.join('\n');
	assert.match(mobileAll, /@clients\/browser\/api\.js/, '手机版要用共用的请求层，不要自己写一个 fetch 封装');
	assert.match(mobileAll, /@clients\/browser\/table-crud\.js/, '表格协议要用共用的那一份');
	assert.match(mobileAll, /tableRequestQuery|actionVisibleForRow/, 'include 与行动作可见性走协议层，不要在手机版里重写');
	// 协议层里已经有的东西，手机版不该再写一遍
	assert.doesNotMatch(mobileAll, /includes\.add\(['"]schema['"]\)/, 'include 的算法只该有一份');
	assert.doesNotMatch(mobileAll, /visibleWhen\.values\.includes/, '行动作可见性只该有一份');

	/**
	 * 两套 UI 的产物要彼此独立：手机版里混进桌面版的 antd，包会大一倍，而手机上流量与
	 * 首屏时间都金贵——现在是 1.4 MB 对 0.5 MB。
	 */
	const mobileBundle = await readFile(resolve(projectDirectory, 'public/bundle-antd-mobile.js'), 'utf8');
	assert.ok(mobileBundle.includes('adm-'), '手机版产物里应当有 antd-mobile 的类名前缀');
	assert.doesNotMatch(mobileBundle, /\bant-btn\b|\bant-table\b/, '手机版不该打进桌面版 antd');

	console.log('web clients test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
