import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * 文档链接和文字里写出来的仓库内路径，必须指向真实存在的文件或目录。
 *
 * 这个检查的由来：需求文档要按站点重排（`docs/<站点>/`），而指向它们的不只是文档之间的相对
 * 链接——`AGENTS.md`、`docs/project/architecture.md`、`docs/releases/`、`shared/audit-tables.mts` 和几个
 * 测试脚本都按路径写着 `docs/requirements/xxx.md`。挪一次文件要改一圈，而**改漏一处不会有任何
 * 报错**：断链在 Markdown 里渲染成一样的蓝字，点下去才是 404，代码注释里的死路径更是永远不会
 * 有人发现。人工核对一遍不难，难的是每次都不漏。
 *
 * 查两样：
 * 1. **Markdown 相对链接** `[文字](路径)`——外链、`mailto:`、纯锚点跳过。
 * 2. **正文与代码注释里写出来的路径**（`docs/sites/sms/client-integration.md`、`'docs/integration'`）。
 *    这一类比链接更容易被漏掉，因为它不长得像链接。
 *
 * 两处**不查**，都是查了会误报的：
 * - **锚点（`#小节`）不查。** 中文标题的 slug 规则各渲染器不一致，按 GitHub 的写死会在别处误报。
 * - **带 `*`、`<>`、`...` 的不查。** 那是模式和占位符（`prisma/*.prisma`、`server/routes/<site>/...`），
 *   本来就没有对应的文件。
 */
const projectDirectory = resolve(import.meta.dirname, '..');

/** 顶层代码与文档目录。路径引用以它们开头才算这个仓库自己的路径，`node_modules/xxx` 之类不算。 */
const REPO_ROOTS = ['docs', 'scripts', 'server', 'clients', 'shared', 'prisma', 'tools', 'migrations', 'wwwroot'];

const SKIP_DIRECTORIES = ['node_modules', '.git', 'dist', '.generated', 'database', 'certs', 'public'];

const walk = async (directory) => {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (SKIP_DIRECTORIES.includes(entry.name)) continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await walk(full));
		else found.push(full);
	}
	return found;
};

const exists = async (path) => {
	try { await stat(path); return true; } catch { return false; }
};

/**
 * 路径写得对、但文件确实不存在的地方，逐条写明理由。空着是好事：需要豁免通常说明
 * 文字该改，而不是检查该放宽。
 */
const exempt = [
	{ file: 'docs/README.md', target: 'docs/sites/sms/sms-shortcut-generator.md', reason: '反例：写作约定拿它说明「文件名不重复站点名」，不存在正是这句话要说的' },
	{ file: 'clients/browser/device-fingerprint.ts', target: 'clients/shared/', reason: '对照句：「放在 clients/browser/ 而不是 clients/shared/」，那个目录不存在正是这句话要说的' },
	{ file: 'docs/sites/base/maintenance-toolbox.md', target: 'scripts/maintenance.mjs', reason: '需求文档写的是「建议统一入口」，这个入口尚未实现；同一个代码块里列着实际实现 scripts/maintenance-toolbox.cjs' },
	{ file: 'docs/sites/global/site-database-routing-and-isolation.md', target: 'server/api', reason: '讲沿革：多站点改造前的目录，这篇文档说的就是把它迁走' },
	{ file: 'docs/sites/global/site-database-routing-and-isolation.md', target: 'server/navigation.mts', reason: '同上，改造前的导航入口' },
	{ file: 'docs/sites/global/site-database-routing-and-isolation.md', target: 'server/routes/site1/api/panel/admin/base/data.mts', reason: '举例：site1 是说明站点覆盖时随手起的站点名，不是真站点' },
	{ file: 'scripts/test-approval-actions.mjs', target: 'server/.generated/worker-api-registry.mts', reason: '构建生成物，跑过 typecheck 才有；.generated 本来就不进版本库' },
];
const exempted = (label, target) => exempt.some((item) => item.file === label && item.target === target);

const files = (await walk(projectDirectory)).filter((file) => /\.(md|mts|ts|tsx|mjs|cjs|json)$/.test(file));
assert.ok(files.length >= 100, `扫到的文件太少，遍历逻辑可能失效：${files.length}`);

const problems = [];
let linkCount = 0;
let pathCount = 0;

for (const file of files) {
	const label = file.replace(`${projectDirectory}/`, '');
	// package.json 之外的 json 不看：锁文件和构建配置里没有给人读的路径，扫了只会拖慢并误报。
	if (file.endsWith('.json') && label !== 'package.json') continue;
	// 这个文件自己要把占位符和坏例子写成注释，不能被自己的规则判出错。
	if (label === 'scripts/test-doc-links.mjs') continue;
	const source = await readFile(file, 'utf8');
	const lineOf = (index) => source.slice(0, index).split('\n').length;

	// ---- 1. Markdown 相对链接 ----
	// 围栏代码块里的 `[]()` 不会渲染成链接，那是在展示写法（比如 docs/README.md 里的头部块
	// 示例），检查它是定义上的误报。下面第 2 项的路径引用**照查不误**——代码块里的路径是
	// 给人照着敲的，敲不出来才是真问题。
	const fenced = new Set();
	if (file.endsWith('.md')) {
		let inside = false;
		source.split('\n').forEach((line, index) => {
			if (/^\s*```/.test(line)) { inside = !inside; fenced.add(index + 1); return; }
			if (inside) fenced.add(index + 1);
		});
	}
	if (file.endsWith('.md')) {
		for (const match of source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
			if (fenced.has(lineOf(match.index))) continue;
			const raw = match[1];
			if (/^(https?:|mailto:|#|\/\/)/.test(raw)) continue;
			const target = decodeURIComponent(raw.split('#')[0]);
			if (!target) continue;                       // 纯锚点 [文字](#小节)
			if (/[*<>]|\.{3}|…/.test(target)) continue;  // 占位符，不是具体路径
			const resolved = resolve(dirname(file), target);
			// 指到仓库外的（父目录的 AGENTS.md 之类）核对不了，跳过而不是报错。
			if (!resolved.startsWith(`${projectDirectory}/`)) continue;
			linkCount += 1;
			if (exempted(label, target)) continue;
			if (!await exists(resolved)) problems.push(`${label}:${lineOf(match.index)}  链接指向不存在的 \`${target}\``);
		}
	}

	// ---- 2. 文字与注释里写出来的仓库内路径 ----
	// 前面挨着字母、`/`、`.`、`-` 或 `@` 的不算：那是网址的一段、更长路径的一截，或 `@server/*` 别名。
	const pattern = new RegExp(String.raw`(?<![\w./@-])(?:${REPO_ROOTS.join('|')})/[A-Za-z0-9_@./-]*`, 'g');
	for (const match of source.matchAll(pattern)) {
		// 句末的 `.` 和目录之外的结尾 `-` 不属于路径本身。
		const target = match[0].replace(/[.-]+$/, (tail) => (/^\.[a-z]+$/.test(tail) ? tail : ''));
		if (target.includes('..') || /\.{3}|…/.test(target)) continue;   // 占位符
		pathCount += 1;
		if (exempted(label, target)) continue;
		if (!await exists(resolve(projectDirectory, target))) {
			problems.push(`${label}:${lineOf(match.index)}  提到的路径 \`${target}\` 不存在`);
		}
	}
}

assert.ok(linkCount >= 40, `扫到的 Markdown 链接太少，匹配逻辑可能失效：${linkCount}`);
assert.ok(pathCount >= 100, `扫到的路径引用太少，匹配逻辑可能失效：${pathCount}`);
assert.deepEqual(problems, [], `以下链接或路径指向不存在的文件，读的人会照着它去找：\n  ${problems.join('\n  ')}`);
console.log(`doc links test passed（核对了 ${linkCount} 条 Markdown 链接、${pathCount} 处路径引用，覆盖 ${files.length} 个文件）`);
