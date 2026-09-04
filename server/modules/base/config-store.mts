import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { DatabaseAdapter, DatabaseActorUid } from '../../database/index.mjs';
import { firstSql, runSql, sql } from '../../database/sql.mjs';
import { runOperationSql } from './operation.mjs';

export type ConfigStore = {
	get: (key: string) => Promise<unknown>;
	put: (key: string, value: unknown) => Promise<void>;
};

const memory = new Map<string, unknown>();

export const memoryConfigStore: ConfigStore = {
	get: async (key) => memory.get(key),
	put: async (key, value) => { memory.set(key, value); },
};

const parse = (value: string | undefined) => {
	if (value === undefined) return undefined;
	try { return JSON.parse(value); } catch { return undefined; }
};

/**
 * 配置按租户独立：`base_configs` 的唯一键是 (key, owner_tid)，同一个 key 每个租户各存一份。
 * 读写都只针对当前租户；缺省值由各 normalize* 从代码补齐，不在数据库里存一份"平台默认行"。
 */
/**
 * 写配置是人工操作（站点设置、系统配置、OIDC 接入都在后台表单里改），因此带上请求
 * 上下文走操作层。没有上下文的调用方是启动流程与 CLI，那些不是人做的，照旧直写。
 */
export const createDatabaseConfigStore = (database: DatabaseAdapter, tenantId: DatabaseActorUid = null, c?: Context<AppEnv>): ConfigStore => ({
	get: async (key) => {
		// 只读当前租户自己的值。读不到不回落到别的租户——各 normalize* 会用代码里的默认值补齐，
		// 例如 defaultSiteSettings。默认值属于代码，不属于数据。
		const where = [{ column: 'key', value: key }, ...(tenantId === null ? [] : [{ column: 'owner_tid', value: tenantId }])];
		const row = await firstSql<{ value: string }>(database, sql({ database }).select({ table: 'base_configs', columns: { value: 'value' }, where }));
		return parse(row?.value);
	},
	put: async (key, value) => {
		const statement = sql({ database }).upsert('base_configs', ['key', 'owner_tid'], { key, value: JSON.stringify(value) }, ['value', 'updated_at']);
		if (c) await runOperationSql(c, database, statement);
		else await runSql(database, statement);
	},
});

export const createD1ConfigStore = createDatabaseConfigStore;
