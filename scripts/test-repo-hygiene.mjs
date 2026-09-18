import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/**
 * 版本库里不该出现构建产物、二进制和秘密。
 *
 * 这个检查的由来：AGENTS.md 要求「改动涉及超过 10KB 的文件时先确认它该不该进版本库」，而把这件事
 * 交给「记得看一眼」是不成立的。挡住 macOS `.app` 包的其实是 `.gitignore`，不是谁查过——而
 * `.gitignore` 写错一行就全漏：一条本想忽略编出来的二进制的通配规则，却把同名的**工具目录**整个
 * 忽略掉了（gitignore 的模式分不清文件和目录），是 `git add` 之后只剩一个 README 才暴露的。漏写一条，
 * 一个 300KB 的二进制就这么进去了，而 **git 历史删不掉**：提交一次就是永久公开。
 *
 * 查三样，任意一样命中就失败：
 * 1. **一看就是产物或秘密的路径**（`.env`、`.app/`、压缩包、数据库文件、私钥、生成的 Embedded.swift…）；
 * 2. **内容是二进制的**（前 8KB 里有 NUL 字节）——编出来的可执行文件多半没有扩展名，只能看内容；
 * 3. **超过 10KB 且不是源码/文档扩展名的**——这一条对应 AGENTS.md 那句「误加的二进制或数据库导出」，
 *    正常的长文档和长脚本不受影响，所以豁免名单能一直保持很短。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const SIZE_LIMIT = 10 * 1024;

/** 明摆着是源码或文档：再长也不用解释。 */
const SOURCE_EXTENSIONS = new Set([
	'mts', 'mjs', 'cjs', 'ts', 'tsx', 'js', 'jsx', 'md', 'sql', 'prisma', 'swift',
	'sh', 'command', 'bat', 'json', 'jsonc', 'xml', 'html', 'css', 'yml', 'yaml', 'txt', 'plist',
]);

/** 一看就不该进库的。命中就失败，不看大小——秘密可以只有 40 个字节。 */
const ARTIFACT_RULES = [
	{ test: (path, name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example'), why: '配置里带凭证，只能留在本机' },
	{ test: (path) => path.split('/').some((part) => part.endsWith('.app')), why: 'macOS 应用包是构建产物' },
	{ test: (path) => /\/(dist|node_modules|build|\.generated)\//.test(`/${path}/`), why: '构建目录' },
	{ test: (path, name) => name === 'Embedded.swift', why: '由构建脚本生成，带凭证时含明文密钥' },
	{ test: (path, name) => name === '.DS_Store', why: 'Finder 留下的，不是项目内容' },
	{ test: (path) => /\.(zip|tar|gz|tgz|bz2|dmg|pkg|jar|class|o|a|dylib|so|exe)$/i.test(path), why: '压缩包或编译产物' },
	{ test: (path) => /\.(sqlite3?|db|mdb|dump)$/i.test(path), why: '数据库文件或导出' },
	{ test: (path) => /\.(pem|key|p12|pfx|keystore|jks|keychain)$/i.test(path), why: '私钥或证书库' },
	{ test: (path) => /\.(log|map)$/i.test(path), why: '日志或 sourcemap，都是产物' },
];

/**
 * 确实要进库的例外，逐条写明理由。**保持很短**：需要加一条时先想清楚是不是该改 `.gitignore`。
 */
const allowed = [
	{ path: '.vscode/xspace.ttf', reason: '编辑器字体，1.5KB，编辑器配置的一部分而不是构建产物' },
];
const allowedFor = (path) => allowed.find((item) => item.path === path);

/** 前 8KB 里有 NUL 就当二进制。编出来的可执行文件常常没有扩展名，只能看内容。 */
const looksBinary = async (path) => {
	const handle = await open(path, 'r');
	try {
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
};

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectDirectory, maxBuffer: 64 * 1024 * 1024 })
	.toString('utf8').split('\0').filter(Boolean);
assert.ok(tracked.length >= 100, `被跟踪的文件太少，git ls-files 可能没跑对：${tracked.length}`);

const problems = [];
let checked = 0;
for (const path of tracked) {
	const full = resolve(projectDirectory, path);
	let size;
	try { size = (await stat(full)).size; } catch { continue; }   // 索引里有、盘上没有（删了还没提交）
	checked += 1;
	const name = basename(path);
	const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
	const exempt = allowedFor(path);

	const artifact = ARTIFACT_RULES.find((rule) => rule.test(path, name));
	if (artifact && !exempt) { problems.push(`${path}  ${artifact.why}`); continue; }

	if (await looksBinary(full)) {
		if (!exempt) problems.push(`${path}  内容是二进制（${size} 字节）`);
		continue;
	}

	if (size > SIZE_LIMIT && !SOURCE_EXTENSIONS.has(extension) && !exempt) {
		problems.push(`${path}  ${size} 字节，超过 ${SIZE_LIMIT}，而且不是源码或文档的扩展名`);
	}
}

assert.deepEqual(problems, [], `以下文件不该在版本库里。确实该进的，加进 scripts/test-repo-hygiene.mjs 的 allowed 并写明理由；\n不该进的，加进 .gitignore 并 \`git rm --cached\` —— **注意历史删不掉，已经推上去就当它永久公开**：\n  ${problems.join('\n  ')}`);
console.log(`repo hygiene test passed（核对了 ${checked} 个被跟踪文件）`);
