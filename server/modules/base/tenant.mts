import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, sql } from '@server/database/sql.mjs';

/**
 * 主机名到租户的第二阶段解析。
 *
 * 控制面只回答"这个请求用哪套代码、哪个库"（global_site_hosts，见 site-router）；
 * 租户归属由站点库自己回答，因此只能在数据库选定之后进行。两张表里出现同一个主机名，
 * 但回答的是两个不同的问题。
 *
 * 与控制面一样按库整表缓存，普通请求不查库。
 */
type TenantSnapshot = { loadedAt: number; hosts: Map<string, string>; defaultTenantId: string | null };

const snapshots = new WeakMap<object, TenantSnapshot>();
const loading = new WeakMap<object, Promise<TenantSnapshot>>();
const ttlMs = 30_000;

const loadSnapshot = async (database: DatabaseAdapter): Promise<TenantSnapshot> => {
	const [hostRows, defaultRows] = await Promise.all([
		allSql<{ hostname: string; tenant_id: string }>(database, sql({ database }).select({
			table: 'base_tenant_hosts',
			columns: { hostname: 'hostname', tenant_id: { column: 'tenant_id', cast: 'text' } },
			where: [{ column: 'status', value: 'enabled' }],
		})),
		allSql<{ id: string }>(database, sql({ database }).select({
			table: 'base_tenants',
			columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'key', value: 'default' }, { column: 'status', value: 'enabled' }],
			limit: 1,
		})),
	]);
	return {
		loadedAt: Date.now(),
		hosts: new Map(hostRows.map((row) => [row.hostname.toLowerCase(), row.tenant_id])),
		defaultTenantId: defaultRows[0]?.id ?? null,
	};
};

const currentSnapshot = async (database: DatabaseAdapter) => {
	const key = database as object;
	const cached = snapshots.get(key);
	if (cached && Date.now() - cached.loadedAt < ttlMs) return cached;
	const pending = loading.get(key) ?? loadSnapshot(database).finally(() => loading.delete(key));
	loading.set(key, pending);
	const snapshot = await pending;
	snapshots.set(key, snapshot);
	return snapshot;
};

/** 绑定或解除租户域名后调用，避免运维以为操作没生效。 */
export const refreshTenantHosts = (database: DatabaseAdapter) => { snapshots.delete(database as object); };

/**
 * 解析当前请求所属的租户。主机名没有绑定时落到默认租户，
 * 单租户部署因此开箱即用：所有人都在 base_tenants 的 default 行下。
 */
export const resolveTenantId = async (database: DatabaseAdapter, hostname: string): Promise<string | null> => {
	const snapshot = await currentSnapshot(database).catch(() => null);
	if (!snapshot) return null;
	return snapshot.hosts.get(hostname.toLowerCase()) ?? snapshot.defaultTenantId;
};
