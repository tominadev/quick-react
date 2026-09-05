import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseAdapter } from './index.mjs';
import { firstSql, runSql, sql } from './sql.mjs';
import { siteSettingsKeys } from '../modules/base/site-settings.mjs';

const ensureMigrationTable = async (database: DatabaseAdapter) => {
	const keyType = database.dialect === 'mysql' ? 'VARCHAR(512)' : 'TEXT';
	const numberType = database.dialect === 'sqlite' || !database.dialect ? 'INTEGER' : 'BIGINT';
	const idDefinition = database.dialect === 'mysql'
		? 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY'
		: database.dialect === 'postgresql'
			? 'BIGSERIAL NOT NULL PRIMARY KEY'
			: 'INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT';
	// Migration bookkeeping is infrastructure metadata rather than a site model,
	// but it follows the same fixed audit-column contract as every data table.
	await database.exec?.(`CREATE TABLE IF NOT EXISTS global_schema_migrations (id ${idDefinition}, created_at ${numberType} NOT NULL, updated_at ${numberType} NOT NULL, deleted_at ${numberType} NOT NULL DEFAULT 0, pended_at ${numberType} NOT NULL DEFAULT 0, created_duid ${numberType} NULL, updated_duid ${numberType} NULL, owner_tid ${numberType} NOT NULL DEFAULT 1, owner_bid ${numberType} NOT NULL DEFAULT 1, owner_uid ${numberType} NULL, migration_key ${keyType} NOT NULL, applied_at ${numberType} NOT NULL, UNIQUE (migration_key, deleted_at))`);
};

export const migrateDatabase = async (database: DatabaseAdapter, migrationsRoot: string, migrationGroups: string[]) => {
	if (!database.exec) throw new Error('Database adapter does not support migrations');
	await ensureMigrationTable(database);
	const dialectRoot = database.dialect && database.dialect !== 'sqlite' ? join(migrationsRoot, database.dialect) : migrationsRoot;
	for (const group of migrationGroups) {
		const directory = join(dialectRoot, group);
		const files = (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT' && database.dialect && database.dialect !== 'sqlite') throw new Error(`Missing ${database.dialect} migrations for group ${group}`);
			if (error.code === 'ENOENT') return [];
			throw error;
		})).filter((file) => file.endsWith('.sql')).sort();
		for (const file of files) {
			const migrationKey = `${group}/${file}`;
			const apply = async (target: DatabaseAdapter) => {
				const applied = await firstSql(target, sql({ database: target }).select({ table: 'global_schema_migrations', columns: { migration_key: 'migration_key' }, where: [{ column: 'migration_key', value: migrationKey }] }));
				if (applied) return;
				const migrationSql = await readFile(join(directory, file), 'utf8');
				await target.exec?.(migrationSql);
				await runSql(target, sql({ database: target }).insert('global_schema_migrations', { migration_key: migrationKey, applied_at: Date.now() }));
			};
			if (database.transaction) await database.transaction(apply);
			else await apply(database);
		}
	}
};

const seedBaseDatabase = async (database: DatabaseAdapter) => {
	// 平台默认引导状态（owner_tid 为 NULL）：各租户没有自己的行时回落到它。
	await runSql(database, sql({ database }).ignoreInsert('base_bootstrap', ['key', 'owner_tid'], { key: 'initial_admin', value: 'open' }));
	// 默认租户与它的主分站：主机名解析不到时一律落到这一对，单租户单分站部署因此开箱即用。
	// 每个域名都必须绑定分站，所以每个租户都要有主分站——新建租户时同样要建一个。
	await runSql(database, sql({ database }).ignoreInsert('base_tenants', ['key'], { key: 'default', title: '默认租户', status: 'enabled' }));
	await runSql(database, sql({ database }).ignoreInsert('base_branches', ['key', 'owner_tid'], { key: 'main', title: '主分站', status: 'enabled' }));
	// 三条站点配置先建成空行。
	//
	// 不建的话，每张设置表单的**第一次保存**是 INSERT，而新增不留痕、也就不走审批
	// （§3.0）——刚建好的站点上，谁先动哪一页，那一页就有一次免审的机会。行先在那儿，
	// 之后所有保存都是 UPDATE，一律排队。
	//
	// 值留空而不是写一份默认值：默认值属于代码（各 normalize* 补齐），不属于数据。
	for (const key of Object.values(siteSettingsKeys)) {
		await runSql(database, sql({ database }).ignoreInsert('base_configs', ['key', 'owner_tid'], { key, value: {} }));
	}
};

export const migrateDefaultDatabase = async (database: DatabaseAdapter, migrationsRoot: string) => {
	await migrateDatabase(database, migrationsRoot, ['global', 'base']);
	// Prisma generates schema only. Keep the two required bootstrap rows as
	// runtime seed data so a freshly generated database remains usable.
	await runSql(database, sql({ database }).ignoreInsert('global_sites', ['key'], {
		key: 'global', title: '全局控制面', base_site_key: 'base', dsn: '', database_binding: '',
		status: 'enabled', migration_status: 'ready', is_default: 1, is_system: 1,
	}));
	await seedBaseDatabase(database);
};

export { seedBaseDatabase };

const siteKeyPattern = /^[a-z][a-z0-9_]*$/;

/** Register code-defined business sites without overwriting administrator settings. */
export const initializeCodeSites = async (
	database: DatabaseAdapter,
	codeSites: readonly string[],
	siteNames: Record<string, string> = {},
	legacySiteNames: Record<string, string> = {},
) => {
	for (const siteKey of codeSites) {
		if (!siteKeyPattern.test(siteKey) || siteKey === 'base') continue;
		const title = siteNames[siteKey] || siteKey;
		const existing = await firstSql<{ title: string }>(database, sql({ database }).select({ table: 'global_sites', columns: { title: 'title' }, where: [{ column: 'key', value: siteKey }] }));
		if (!existing) {
			await runSql(database, sql({ database }).insert('global_sites', { key: siteKey, title, base_site_key: 'base', dsn: '', database_binding: '', status: 'enabled', migration_status: 'ready', is_default: 0, is_system: 0 }));
			continue;
		}
		// 仅修正过去由首个导航项误填的默认名称，不覆盖主人手工设置的站点名称。
		if (legacySiteNames[siteKey] && existing.title === legacySiteNames[siteKey] && existing.title !== title) {
			await runSql(database, sql({ database }).update('global_sites', { title }, { key: siteKey }));
		}
	}
};
