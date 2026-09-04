import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const projectDirectory = resolve(import.meta.dirname, '..');
const generator = join(projectDirectory, 'scripts', 'generate-prisma-migrations.mjs');
const migrationsDirectory = join(projectDirectory, 'migrations');
const prismaDirectory = join(projectDirectory, 'prisma');
// 缓存放在 node_modules 下：不进版本库，CI 与全新克隆照常做完整校验，
// 只有本机重复构建才享受短路。
const cacheDirectory = join(projectDirectory, 'node_modules', '.cache', 'quick-react');
const cacheFile = join(cacheDirectory, 'prisma-verify-hash');

/**
 * 校验一次要重新生成全部迁移，而每生成一个都要启动一次 Prisma CLI，总计十几秒。
 * 它回答的问题是"prisma schema 与 migrations 是否仍然一致"，那么只要输入与输出
 * 一个字节都没变，上一次的结论就仍然成立。
 *
 * 哈希同时覆盖 prisma schema、全部迁移 SQL 和生成器本身：任一改动都会让缓存失效，
 * 因此既挡得住"改了 schema 忘了重新生成"，也挡得住"手工改了迁移文件"。
 */
const fingerprint = async () => {
	const hash = createHash('sha256');
	const inputs = [
		...(await readdir(prismaDirectory).catch(() => [])).filter((name) => name.endsWith('.prisma')).sort().map((name) => join(prismaDirectory, name)),
		join(projectDirectory, 'scripts', 'generate-prisma-migrations.mjs'),
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
	const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-prisma-verify-'));
	try {
		execFileSync(process.execPath, [generator, `--output-root=${temporaryDirectory}`], {
			cwd: projectDirectory,
			stdio: 'inherit',
		});
		const [expectedFiles, actualFiles] = await Promise.all([
			collectSqlFiles(temporaryDirectory),
			collectSqlFiles(migrationsDirectory),
		]);
		const expectedSet = new Set(expectedFiles);
		const actualSet = new Set(actualFiles);
		const differences = [];
		for (const file of expectedFiles) {
			if (!actualSet.has(file)) {
				differences.push(`缺少生成迁移：${file}`);
				continue;
			}
			const [expected, actual] = await Promise.all([
				readFile(join(temporaryDirectory, file)),
				readFile(join(migrationsDirectory, file)),
			]);
			if (!expected.equals(actual)) differences.push(`迁移与 Prisma Schema 不一致：${file}`);
		}
		for (const file of actualFiles) if (!expectedSet.has(file)) differences.push(`存在未由 Prisma 生成的迁移：${file}`);
		if (differences.length) {
			throw new Error([
				'Prisma Schema 不是当前迁移文件的唯一来源，已停止继续执行。',
				...differences,
				'请修改 prisma/*.prisma 后运行 npm run prisma:migrations。',
			].join('\n'));
		}
		await mkdir(cacheDirectory, { recursive: true }).catch(() => {});
		await writeFile(cacheFile, `${current}\n`).catch(() => {});
		console.log(`Prisma Schema 与 migrations 一致（${actualFiles.length} 个 SQL 文件）`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
};

await main();
