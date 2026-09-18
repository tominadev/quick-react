const path = require('node:path');
const fs = require('node:fs');
const { Marked } = require('marked');

/**
 * 把 `docs/` 渲染成一个可以用浏览器读的静态站点，输出到 `public/docs/`。
 *
 * **产物是静态资源，不进 worker 产物。** 文档有 560KB（gzip 后 216KB），塞进 `dist/worker.mjs`
 * 会让每个请求都背着它；而 `public/` 两侧本来就有人服务——Node 是 `serveStatic`，Worker 是
 * `wrangler.jsonc` 里的 `ASSETS` 绑定。所以这里只写文件，不生成任何被 import 的模块。
 *
 * 渲染放在构建期：运行时和前端 bundle 都不需要 markdown 解析器，`marked` 只是 devDependency。
 *
 * 链接一律改写成**根绝对路径**（`/docs/sites/sms/x.html`）。文档之间的相对链接层数各不相同，
 * 逐个按深度重算既易错又没必要——源链接是否有断由 `npm run test:doc-links` 保证，这里只做映射。
 */
const projectDir = path.resolve(__dirname, '..');
const outputRoot = path.join(projectDir, 'public', 'docs');
const BASE = '/docs';

/** `docs/` 之外、但被文档链接到的几篇也一起渲染，否则站点里点过去是 404。 */
const EXTRA_PAGES = ['AGENTS.md', 'tools/README.md', 'tools/sms/shortcut-generator/README.md'];

/** 侧栏分组：前缀 → 组名。顺序就是侧栏顺序。 */
const SECTIONS = [
	['docs/project/', '这个仓库本身'],
	['docs/sites/base/', 'base —— 公共后台'],
	['docs/sites/global/', 'global —— 全局控制面'],
	['docs/sites/passport/', 'passport —— 身份中心'],
	['docs/sites/sms/', 'sms —— 短信平台'],
	['docs/sites/pve/', 'pve'],
	['docs/sites/loki/', 'loki'],
	['docs/conventions/', '跨全站约定'],
	['docs/postmortems/', '事故复盘'],
	['docs/releases/', '发布资料'],
	['', '仓库根'],   // AGENTS.md、tools/ 的 README
];

const walk = (directory) => fs.existsSync(directory)
	? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.md') ? [full] : []);
	})
	: [];

/**
 * GitHub 的标题锚点算法：转小写 → 去掉字母数字空格连字符以外的字符 → 空格转连字符。
 * 中文标点也要去掉，文档里就有 `#身份关联的判断准则2026-08-28-确立` 这样的链接指着「（2026-08-28 确立）」。
 */
const slug = (text) => text.toLowerCase()
	.replace(/[^\p{L}\p{N}\s-]/gu, '')
	.trim().replace(/\s+/g, '-');

const escapeHtml = (text) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** 仓库相对路径 → 站点里的 URL。`docs/` 下的平铺在站点根，其余的挂在 `_repo/` 下。 */
const urlFor = (repoPath) => repoPath.startsWith('docs/')
	? `${BASE}/${repoPath.slice('docs/'.length).replace(/\.md$/, '.html')}`
	: `${BASE}/_repo/${repoPath.replace(/\.md$/, '.html')}`;
const fileFor = (repoPath) => path.join(outputRoot, urlFor(repoPath).slice(`${BASE}/`.length));

const CSS = `
:root { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --code-bg:#f6f8fa; --link:#0969da; --side:#f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --code-bg:#151b23; --link:#4493f8; --side:#010409; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
.layout { display:flex; align-items:flex-start; }
nav { flex:0 0 280px; background:var(--side); border-right:1px solid var(--line); padding:20px 16px 48px; height:100vh; overflow-y:auto; position:sticky; top:0; }
nav h2 { font-size:12px; text-transform:none; color:var(--muted); margin:20px 0 6px; font-weight:600; letter-spacing:.02em; }
nav h2:first-of-type { margin-top:8px; }
nav a { display:block; padding:3px 8px; margin:1px -8px; border-radius:6px; color:var(--fg); text-decoration:none; font-size:14px; }
nav a:hover { background:var(--line); }
nav a.current { background:var(--link); color:#fff; }
nav .home { font-weight:600; font-size:15px; margin-bottom:4px; }
main { flex:1 1 auto; min-width:0; padding:32px 40px 96px; max-width:900px; }
main :first-child { margin-top:0; }
h1,h2,h3,h4 { line-height:1.3; margin:1.6em 0 .6em; }
h1 { font-size:28px; border-bottom:1px solid var(--line); padding-bottom:.3em; }
h2 { font-size:22px; border-bottom:1px solid var(--line); padding-bottom:.3em; }
h3 { font-size:18px; } h4 { font-size:16px; }
a { color:var(--link); }
code { background:var(--code-bg); padding:.15em .35em; border-radius:5px; font-size:85%; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow-x:auto; }
pre code { background:none; padding:0; font-size:13px; line-height:1.5; }
blockquote { margin:1em 0; padding:0 1em; color:var(--muted); border-left:.25em solid var(--line); }
table { border-collapse:collapse; display:block; overflow-x:auto; max-width:100%; margin:1em 0; }
th,td { border:1px solid var(--line); padding:6px 13px; text-align:left; vertical-align:top; }
th { background:var(--code-bg); }
hr { border:none; border-top:1px solid var(--line); margin:2em 0; }
img { max-width:100%; }
.toggle { display:none; }
@media (max-width: 860px) {
  .layout { display:block; }
  nav { position:static; height:auto; width:auto; border-right:none; border-bottom:1px solid var(--line); }
  main { padding:20px 16px 64px; }
}
`;

const shell = (title, sidebar, body) => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body><div class="layout">
<nav>${sidebar}</nav>
<main>${body}</main>
</div></body></html>
`;

const generate = () => {
	const pages = [...walk(path.join(projectDir, 'docs')).map((f) => path.relative(projectDir, f).replaceAll(path.sep, '/')),
		...EXTRA_PAGES.filter((f) => fs.existsSync(path.join(projectDir, f)))].sort();

	// 标题取每篇的第一个 `# `，没有就用文件名。
	const titles = new Map(pages.map((repoPath) => {
		const source = fs.readFileSync(path.join(projectDir, repoPath), 'utf8');
		const heading = source.match(/^#\s+(.+)$/m);
		return [repoPath, heading ? heading[1].replace(/`/g, '') : path.basename(repoPath, '.md')];
	}));

	const sidebarFor = (current) => SECTIONS.map(([prefix, label]) => {
		const inSection = pages.filter((p) => p !== 'docs/README.md'
			&& (prefix ? p.startsWith(prefix) : !p.startsWith('docs/')));
		if (!inSection.length) return '';
		const links = inSection.map((p) => `<a href="${urlFor(p)}"${p === current ? ' class="current"' : ''}>${escapeHtml(titles.get(p))}</a>`).join('');
		return `<h2>${escapeHtml(label)}</h2>${links}`;
	}).join('');

	fs.rmSync(outputRoot, { recursive: true, force: true });
	let written = 0;
	for (const repoPath of pages) {
		const source = fs.readFileSync(path.join(projectDir, repoPath), 'utf8');
		const marked = new Marked({ gfm: true, breaks: false });
		marked.use({
			renderer: {
				heading({ tokens, depth }) {
					const text = this.parser.parseInline(tokens);
					const id = slug(text.replace(/<[^>]+>/g, ''));
					return `<h${depth} id="${escapeHtml(id)}">${text}</h${depth}>\n`;
				},
				link({ href, title, tokens }) {
					const text = this.parser.parseInline(tokens);
					let target = href;
					if (!/^([a-z]+:|#|\/)/i.test(href)) {
						const [file, anchor] = href.split('#');
						const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), file));
						// 站点里有这一篇就指过去；没有（指向源码文件之类）就保留原样，它在网页上点不动，
						// 但也不该被改写成一个假地址。
						if (pages.includes(resolved)) target = urlFor(resolved) + (anchor ? `#${slug(decodeURIComponent(anchor))}` : '');
					}
					const attr = title ? ` title="${escapeHtml(title)}"` : '';
					return `<a href="${escapeHtml(target)}"${attr}>${text}</a>`;
				},
			},
		});
		const html = shell(titles.get(repoPath), sidebarFor(repoPath), marked.parse(source));
		const outputFile = fileFor(repoPath);
		fs.mkdirSync(path.dirname(outputFile), { recursive: true });
		fs.writeFileSync(outputFile, html);
		written += 1;
	}
	// `docs/README.md` 就是站点首页：/docs/ 与 /docs/README.html 是同一页。
	fs.copyFileSync(fileFor('docs/README.md'), path.join(outputRoot, 'index.html'));
	return written;
};

module.exports = { generate };
if (require.main === module) console.log(`docs site: ${generate()} 页 -> public/docs/`);
