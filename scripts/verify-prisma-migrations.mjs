import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const projectDirectory = resolve(import.meta.dirname, '..');
const generatorPath = join(projectDirectory, 'scripts', 'generate-prisma-migrations.mjs');
const prismaBin = join(projectDirectory, 'node_modules/.bin/prisma');
const snapshotDirectory = join(projectDirectory, 'prisma', '.applied');
const sites = ['global', 'base', 'passport', 'pve'];
const migrationsDirectory = join(projectDirectory, 'migrations');
const prismaDirectory = join(projectDirectory, 'prisma');
// 缓存放在 node_modules 下：不进版本库，CI 与全新克隆照常做完整校验，
// 只有本机重复构建才享受短路。
const cacheDirectory = join(projectDirectory, 'node_modules', '.cache', 'quick-react');
const cacheFile = join(cacheDirectory, 'prisma-verify-hash');

/**
 * 校验要为每个站点启动一次 Prisma CLI（各约 1 秒）。它回答的问题是"schema 的每一处
 * 结构变化是否都已经生成过迁移文件"，那么只要输入一个字节都没变，上一次的结论仍然成立。
 *
 * 哈希覆盖 prisma schema、快照、全部迁移 SQL 和生成器本身：任一改动都会让缓存失效。
 */
const fingerprint = async () => {
	const hash = createHash('sha256');
	const inputs = [
		...(await readdir(prismaDirectory).catch(() => [])).filter((name) => name.endsWith('.prisma')).sort().map((name) => join(prismaDirectory, name)),
		generatorPath,
		...sites.map((site) => join(snapshotDirectory, `${site}.prisma`)),
		...(await collectSqlFiles(migrationsDirectory)).map((name) => join(migrationsDirectory, name)),
	];
	for (const file of inputs) {
		hash.update(file.slice(projectDirectory.length));
		hash.update(await readFile(file).catch(() => Buffer.alloc(0)));
	}
	return hash.digest('hex');
};

const collectSqlFiles = async (directory, prefix = '') => {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		const relativePath = join(prefix, entry.name);
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await collectSqlFiles(fullPath, relativePath));
		else if (entry.isFile() && entry.name.endsWith('.sql')) files.push(relativePath);
	}
	return files.sort();
};

const main = async () => {
	const current = await fingerprint();
	if (process.env.PRISMA_VERIFY_FORCE !== '1' && await readFile(cacheFile, 'utf8').then((value) => value.trim() === current, () => false)) {
		console.log('Prisma Schema 与 migrations 一致（沿用上次校验结果，输入未变）');
		return;
	}
	// 增量迁移之后不能再用「重新生成后逐字节比对」来校验：历史迁移是不可重新推导的事实，
	// 重跑生成器只会产出「从快照到现在」的那一个增量。
	//
	// 改成校验**快照是否已经追上 schema**：diff 为空就说明所有结构变化都已经生成过迁移。
	// 它挡得住「改了 schema 忘了跑 prisma:migrations」，那正是这个校验唯一要挡的事。
	// 手工改历史迁移文件挡不住——那也不是校验能解决的问题：已经跑过那个迁移的库
	// 不会因为文件被改而回退。
	const differences = [];
	await Promise.all(sites.map(async (site) => {
		const snapshot = join(snapshotDirectory, `${site}.prisma`);
		if (!await readFile(snapshot, 'utf8').then(() => true, () => false)) {
			differences.push(`缺少 schema 快照：prisma/.applied/${site}.prisma`);
			return;
		}
		const { stdout } = await execFileAsync(prismaBin, ['migrate', 'diff',
			'--from-schema-datamodel', snapshot,
			'--to-schema-datamodel', join(prismaDirectory, `${site}.prisma`), '--script'], {
			cwd: projectDirectory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, DATABASE_URL: 'file:./database/default.sqlite' },
		});
		if (stdout.replace(/^\s*--.*$/gm, '').trim()) differences.push(`prisma/${site}.prisma 有尚未生成迁移的结构变化`);
	}));
	if (differences.length) {
		throw new Error([
			'Prisma Schema 与迁移文件不同步，已停止继续执行。',
			...differences,
			'请运行 npm run prisma:migrations -- --name=<本次改动的简述>。',
		].join('\n'));
	}
	{
		await mkdir(cacheDirectory, { recursive: true }).catch(() => {});
		await writeFile(cacheFile, `${current}\n`).catch(() => {});
		console.log(`Prisma Schema 与 migrations 一致（${(await collectSqlFiles(migrationsDirectory)).length} 个 SQL 文件）`);
	}
};

await main();
