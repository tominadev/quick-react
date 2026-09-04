import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, sql } from '@server/database/sql.mjs';

/**
 * 主机名到租户与分站的第二阶段解析。
 *
 * 控制面只回答"这个请求用哪套代码、哪个库"（global_site_hosts，见 site-router）；
 * 租户与分站由站点库自己回答，因此只能在数据库选定之后进行。两张表里出现同一个主机名，
 * 但回答的是两个不同的问题。
 *
 * 每个域名都同时绑定租户和分站，不存在"不属于任何分站"的状态：租户自己的域名绑到它的主分站。
 * 这样用量与计费的聚合不需要处理 NULL 桶。
 *
 * 与控制面一样按库整表缓存，普通请求不查库。
 */
export type HostScope = { tenantId: string | null; branchId: string | null };

type HostSnapshot = { loadedAt: number; hosts: Map<string, HostScope>; fallback: HostScope };

const snapshots = new WeakMap<object, HostSnapshot>();
const loading = new WeakMap<object, Promise<HostSnapshot>>();
const ttlMs = 30_000;

const loadSnapshot = async (database: DatabaseAdapter): Promise<HostSnapshot> => {
	const [hostRows, defaultTenant, defaultBranch] = await Promise.all([
		allSql<{ hostname: string; tenant_id: string; branch_id: string }>(database, sql({ database }).select({
			table: 'base_hosts',
			columns: { hostname: 'hostname', tenant_id: { column: 'tenant_id', cast: 'text' }, branch_id: { column: 'branch_id', cast: 'text' } },
			where: [{ column: 'status', value: 'enabled' }],
		})),
		allSql<{ id: string }>(database, sql({ database }).select({
			table: 'base_tenants',
			columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'key', value: 'default' }, { column: 'status', value: 'enabled' }],
			limit: 1,
		})),
		allSql<{ id: string }>(database, sql({ database }).select({
			table: 'base_branches',
			columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'key', value: 'main' }, { column: 'status', value: 'enabled' }],
			orderBy: [{ column: 'id' }],
			limit: 1,
		})),
	]);
	return {
		loadedAt: Date.now(),
		hosts: new Map(hostRows.map((row) => [row.hostname.toLowerCase(), { tenantId: row.tenant_id, branchId: row.branch_id }])),
		fallback: { tenantId: defaultTenant[0]?.id ?? null, branchId: defaultBranch[0]?.id ?? null },
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

/** 绑定或解除域名后调用，避免运维以为操作没生效。 */
export const refreshHostScopes = (database: DatabaseAdapter) => { snapshots.delete(database as object); };

/**
 * 解析当前请求所属的租户与分站。主机名没有绑定时落到默认租户的主分站，
 * 单租户单分站部署因此开箱即用。
 */
export const resolveHostScope = async (database: DatabaseAdapter, hostname: string): Promise<HostScope> => {
	const snapshot = await currentSnapshot(database).catch(() => null);
	if (!snapshot) return { tenantId: null, branchId: null };
	return snapshot.hosts.get(hostname.toLowerCase()) ?? snapshot.fallback;
};
