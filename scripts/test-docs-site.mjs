import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * `/docs` 把 `docs/` 当静态站点服务，构建期生成，运行时零成本。
 *
 * 三件事各自都会悄悄坏掉：
 * 1. **链接**：文档之间的相对链接层数不一，改写错了点过去是 404，而页面本身看起来完全正常；
 * 2. **Node 服务**：`/docs` 无尾斜杠要能出首页（靠 serveStatic 的目录解析），这依赖第三方行为；
 * 3. **Worker 路由顺序**：`run_worker_first` 让 Worker 先看到请求，而带 `accept: text/html` 的
 *    请求会被 `app.get('*')` 当应用页面渲染——文档路由必须排在它前面，否则线上看到的是站点 404。
 *
 * 第 3 条只能查源码顺序：真正跑通那条分支要 Worker 运行时和一套 D1 绑定，这里两样都没有。
 * 查源码顺序不算强，但它盯住的正是会静默坏掉的那一处——有人把兜底路由往上挪，文档就没了。
 */
const require = createRequire(import.meta.url);
const { generate } = require('./generate-docs-site.cjs');
const projectDirectory = new URL('..', import.meta.url).pathname;
const siteRoot = join(projectDirectory, 'public', 'docs');

// ---- 1. 生成：页数、首页、链接与锚点 ----
const pageCount = generate();
assert.ok(pageCount >= 30, `生成的页面太少，遍历可能失效：${pageCount}`);
assert.ok(statSync(join(siteRoot, 'index.html')).isFile(), '/docs 的首页缺失');

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
	const full = join(directory, entry.name);
	return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.html') ? [full] : []);
});
const pages = walk(siteRoot);
const headingIds = new Map(pages.map((file) => [file.slice(siteRoot.length + 1),
	new Set([...readFileSync(file, 'utf8').matchAll(/<h[1-6] id="([^"]+)"/g)].map((match) => match[1]))]));

const linkProblems = [];
let internalLinks = 0, anchoredLinks = 0;
for (const file of pages) {
	const label = file.slice(siteRoot.length + 1);
	for (const match of readFileSync(file, 'utf8').matchAll(/<a href="([^"]+)"/g)) {
		const href = match[1];
		if (href.endsWith('.md') || href.includes('.md#')) { linkProblems.push(`${label} -> ${href}  没改写成 .html`); continue; }
		if (!href.startsWith('/docs/')) continue;
		internalLinks += 1;
		const [target, anchor] = href.slice('/docs/'.length).split('#');
		if (!headingIds.has(target)) { linkProblems.push(`${label} -> ${href}  目标页不存在`); continue; }
		if (!anchor) continue;
		anchoredLinks += 1;
		// 锚点按 GitHub 的 slug 规则生成，文档里的 `#小节` 链接必须真的落在某个标题上。
		if (!headingIds.get(target).has(anchor)) linkProblems.push(`${label} -> ${href}  锚点不存在`);
	}
}
assert.ok(internalLinks >= 40, `站内链接太少，改写可能没生效：${internalLinks}`);
assert.deepEqual(linkProblems, [], `文档站点里有坏链接：\n  ${linkProblems.join('\n  ')}`);

// ---- 2. 文档不能进 worker 产物 ----
// 560KB 的文档塞进产物等于每个请求都背着它，而 public/ 两侧本来就有人服务。
const workerBundle = await readFile(join(projectDirectory, 'dist', 'worker.mjs'), 'utf8').catch(() => '');
if (workerBundle) {
	const marker = readFileSync(join(projectDirectory, 'docs', 'README.md'), 'utf8').split('\n').find((line) => line.length > 30);
	assert.ok(!workerBundle.includes(marker), 'worker 产物里出现了文档正文，文档不该被打包进 dist');
}

// ---- 3. Worker 路由顺序 ----
const workerSource = await readFile(join(projectDirectory, 'server', 'worker.mts'), 'utf8');
// 只认行首的路由注册：注释里也会写到 `app.get('*')`，按裸字符串找会先撞上注释。
const docsRoute = workerSource.search(/^app\.get\('\/docs'/m);
const htmlCatchAll = workerSource.search(/^app\.get\('\*'/m);
assert.ok(docsRoute > 0, 'worker.mts 里没有 /docs 路由');
assert.ok(docsRoute < htmlCatchAll,
	'/docs 路由必须排在 app.get(\'*\') 之前：带 accept: text/html 的请求会被兜底路由当应用页面渲染，'
	+ '线上看到的就是站点 404 而不是文档');

// ---- 4. Node 侧真的服务得出来 ----
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-docs-site-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
try {
	const { app } = await import(`../dist/server.mjs?docs-site=${Date.now()}`);
	const cases = [
		['/docs', '无尾斜杠的目录入口'],
		['/docs/', '带尾斜杠的目录入口'],
		['/docs/sites/sms/shortcut-generator.html', '站点文档'],
		['/docs/_repo/AGENTS.html', 'docs/ 之外但被链接到的文档'],
	];
	for (const [path, what] of cases) {
		const response = await app.request(`http://localhost${path}`, { headers: { accept: 'text/html' } });
		assert.equal(response.status, 200, `${what}（${path}）应当是 200，实际 ${response.status}`);
		const body = await response.text();
		assert.ok(body.includes('<nav>'), `${what}（${path}）返回的不是文档页`);
		assert.ok(!body.includes('__INITIAL_DATA__'), `${what}（${path}）被当成应用页面渲染了`);
	}
	console.log(`docs site test passed（${pageCount} 页，${internalLinks} 条站内链接，其中 ${anchoredLinks} 条带锚点）`);
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
