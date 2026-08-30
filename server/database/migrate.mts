import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseAdapter } from './index.mjs';
import { firstSql, runSql, sql } from './sql.mjs';

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
	await database.exec?.(`CREATE TABLE IF NOT EXISTS global_schema_migrations (id ${idDefinition}, created_at ${numberType} NOT NULL, updated_at ${numberType} NOT NULL, created_duid ${numberType} NULL, updated_duid ${numberType} NULL, migration_key ${keyType} NOT NULL UNIQUE, applied_at ${numberType} NOT NULL)`);
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
	await runSql(database, sql({ database }).ignoreInsert('base_bootstrap', ['key'], { key: 'initial_admin', value: 'open' }));
};

export const migrateDefaultDatabase = async (database: DatabaseAdapter, migrationsRoot: string) => {
	await migrateDatabase(database, migrationsRoot, ['global', 'base']);
	// Prisma generates schema only. Keep the two required bootstrap rows as
	// runtime seed data so a freshly generated database remains usable.
	await runSql(database, sql({ database }).ignoreInsert('global_sites', ['site_key'], {
		site_key: 'global', name: '全局控制面', base_site_key: 'base', dsn: '', database_binding: '',
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
) => {
	for (const siteKey of codeSites) {
		if (!siteKeyPattern.test(siteKey) || siteKey === 'base') continue;
		const name = siteNames[siteKey] || siteKey;
		await runSql(database, sql({ database }).ignoreInsert('global_sites', ['site_key'], { site_key: siteKey, name, base_site_key: 'base', dsn: '', database_binding: '', status: 'enabled', migration_status: 'ready', is_default: 0, is_system: 0 }));
	}
};
