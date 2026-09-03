import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const projectDirectory = resolve(import.meta.dirname, '..');
const generator = join(projectDirectory, 'scripts', 'generate-prisma-migrations.mjs');
const migrationsDirectory = join(projectDirectory, 'migrations');

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
		console.log(`Prisma Schema 与 migrations 一致（${actualFiles.length} 个 SQL 文件）`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
};

await main();
