import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecureServer } from 'node:http2';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { getClientIp } from './modules/base/client-ip.mjs';
import worker from './worker.mjs';
import { createSqliteAdapter } from './database/sqlite.mjs';
import { createMysqlAdapter } from './database/mysql.mjs';
import { createPostgresqlAdapter } from './database/postgresql.mjs';
import type { DatabaseAdapter } from './database/index.mjs';
import { allSql, runSql, sql } from './database/sql.mjs';
import { initializeCodeSites, migrateDatabase, migrateDefaultDatabase, seedBaseDatabase } from './database/migrate.mjs';
import { createDatabaseConfigStore, memoryConfigStore } from './modules/base/config-store.mjs';
import { configureSystemConfig, loadSystemConfig } from './modules/base/system-config.mjs';
import { secureServerOptions } from './modules/base/https-options.mjs';
import { configureTechStack, loadTechStackConfig } from './modules/base/tech-stack.mjs';
import type { WorkerBindings } from './worker.mjs';
import type { AppEnv } from './modules/base/types.mjs';
import { SiteRouter } from './modules/base/site-router.mjs';
import { workerCodeSites, workerSiteNavigations } from './.generated/worker-api-registry.mjs';
import { executeMaintenanceAction } from './modules/base/maintenance/actions.mjs';
import { purgeAuditRetention } from './modules/base/audit.mjs';
import { dispatchPushDeliveries } from './modules/sms/push.mjs';
import { primeSnowflake } from './modules/base/snowflake.mjs';
import { readEnvFile, readEnvValue, resolveWorkerId } from './modules/base/worker-id.mjs';
import { createLokiGateway, loadLokiGatewayConfig } from './routes/loki/gateway.mjs';

const env = process.env;
const skipStartupChecks = env.SKIP_STARTUP_CHECKS === '1';
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const defaultDatabase = createSqliteAdapter(env.DEFAULT_DATABASE_FILE || resolve(projectDirectory, 'database/default.sqlite'));
const siteDatabases = new Map<string, DatabaseAdapter>();
const staticSiteRouter = new SiteRouter(defaultDatabase);
if (!skipStartupChecks) await migrateDefaultDatabase(defaultDatabase, resolve(projectDirectory, 'migrations'));
// worker id 定下来才能发号；发号器备好号段之后，`key` 的生成就是纯内存的同步操作。
const workerId = await resolveWorkerId(resolve(projectDirectory, '.env'));
// 谁能自己批自己：名单放 .env，数据库被拿下的人不该能把自己写进去。
const superUserIds = await readEnvValue(resolve(projectDirectory, '.env'), 'SUPER_USER_IDS');
if (!skipStartupChecks) await primeSnowflake(defaultDatabase, workerId);
const resolveSiteDsn = (dsn: string) => {
	let key = dsn, factory: () => DatabaseAdapter;
	if (dsn.startsWith('sqlite://')) {
		const dsnPath = dsn.slice('sqlite://'.length), filename = dsnPath.startsWith('/') ? dsnPath : resolve(projectDirectory, dsnPath);
		key = `sqlite://${filename}`;
		factory = () => createSqliteAdapter(filename);
	} else if (dsn.startsWith('mysql://') || dsn.startsWith('mysql2://')) {
		factory = () => createMysqlAdapter(dsn.replace(/^mysql2:/, 'mysql:'));
	} else if (dsn.startsWith('postgresql://') || dsn.startsWith('postgres://')) {
		factory = () => createPostgresqlAdapter(dsn);
	} else throw new Error('Database DSN must use sqlite://, mysql://, or postgresql://');
	let database = siteDatabases.get(key);
	if (!database) {
		database = factory();
		siteDatabases.set(key, database);
	}
	return database;
};

const migrateSite = async (siteKey: string) => {
	const rows = await allSql<{ site_key: string; base_site_key: string | null; dsn: string; database_binding: string; is_system: number }>(defaultDatabase, sql({ database: defaultDatabase }).select({ table: 'global_sites', columns: { site_key: 'key', base_site_key: 'base_site_key', dsn: 'dsn', database_binding: 'database_binding', is_system: 'is_system' } }));
	const sites = new Map(rows.map((site) => [site.site_key, site]));
	const site = sites.get(siteKey);
	if (!site || site.is_system) throw new Error('Site is not eligible for business migration');
	if (site.database_binding) throw new Error('D1 Binding migrations must run during deployment');
	const chain: string[] = [];
	const visited = new Set<string>();
	let current = site;
	while (current) {
		if (visited.has(current.site_key) || visited.size >= 8) throw new Error('Invalid site inheritance chain');
		visited.add(current.site_key);
		chain.unshift(current.site_key);
		if (!current.base_site_key || current.base_site_key === 'base') break;
		const parent = sites.get(current.base_site_key);
		if (!parent) throw new Error(`Parent site not found: ${current.base_site_key}`);
		current = parent;
	}
	chain.unshift('base');
	await runSql(defaultDatabase, sql({ database: defaultDatabase }).update('global_sites', { migration_status: 'migrating' }, { key: siteKey }));
	try {
		const target = site.dsn ? resolveSiteDsn(site.dsn) : defaultDatabase;
		await migrateDatabase(target, resolve(projectDirectory, 'migrations'), chain);
		await seedBaseDatabase(target);
		await runSql(defaultDatabase, sql({ database: defaultDatabase }).update('global_sites', { migration_status: 'ready' }, { key: siteKey }));
	} catch (error) {
		await runSql(defaultDatabase, sql({ database: defaultDatabase }).update('global_sites', { migration_status: 'failed' }, { key: siteKey }));
		throw error;
	}
};
const codeSiteNames = Object.fromEntries(Object.entries(workerSiteNavigations).map(([siteKey, navigation]) => {
	const management = navigation.find((item) => item.key === 'panel/admin' || item.key === '/panel/admin');
	const siteNode = management?.children?.find((item) => item.navigationGroup === siteKey || item.key === siteKey);
	return [siteKey, siteNode?.label || siteKey];
}));
const legacyCodeSiteNames = Object.fromEntries(Object.entries(workerSiteNavigations).map(([siteKey, navigation]) => [siteKey, navigation[0]?.label || siteKey]));
if (!skipStartupChecks) {
	await initializeCodeSites(defaultDatabase, workerCodeSites, codeSiteNames, legacyCodeSiteNames);
	const codeSiteRows = await allSql<{ site_key: string; database_binding: string }>(defaultDatabase, sql({ database: defaultDatabase }).select({ table: 'global_sites', columns: { site_key: 'key', database_binding: 'database_binding' }, where: [{ column: 'is_system', value: false }] }));
	for (const site of codeSiteRows) {
		if (!workerCodeSites.includes(site.site_key as typeof workerCodeSites[number]) || site.database_binding) continue;
		await migrateSite(site.site_key);
	}
}
const defaultConfigStore = skipStartupChecks ? memoryConfigStore : createDatabaseConfigStore(defaultDatabase);
configureSystemConfig({
	store: defaultConfigStore,
	defaults: {
		httpPort: env.HTTP_PORT || '80',
		httpsPort: env.HTTPS_PORT || '443',
		domain: env.DOMAIN || 'anan.cc',
		publicOrigin: env.PUBLIC_ORIGIN || '',
		trustedProxyIps: env.TRUSTED_PROXY_IPS || '127.0.0.1,::1,::ffff:127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
		mapAllowedIps: env.MAP_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1',
	},
});
configureTechStack({
	store: defaultConfigStore,
	defaults: {
		nginx: env.MASK_NGINX === '1',
		phpVersion: env.MASK_PHP_VERSION || '',
		apiSuffix: env.API_ROUTE_SUFFIX ?? '.php',
		pageSuffix: env.PAGE_ROUTE_SUFFIX ?? '.html',
	},
});

const systemConfig = await loadSystemConfig();
await loadTechStackConfig();
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const mapAllowedIps = new Set([
	'127.0.0.1', '::1', '::ffff:127.0.0.1',
	...systemConfig.mapAllowedIps.split(',').map((ip) => ip.trim()).filter(Boolean),
]);
const trustedProxyRules = systemConfig.trustedProxyIps.split(',').map((ip) => ip.trim()).filter(Boolean);

const nodeApp = new Hono<AppEnv>();
/**
 * 日志中心网关：绑定到 loki 代码站点的域名整个交给它代理，其余域名不受影响。
 * 放在最前面——代理要的是原样转发，不该先过压缩、ETag 和静态文件那几层。
 * 没有配推送凭据时 loadLokiGatewayConfig 返回 undefined，这段就完全不装配。
 */
const lokiGatewayConfig = loadLokiGatewayConfig({ ...Object.fromEntries(await readEnvFile(resolve(projectDirectory, '.env'))), ...env });
if (lokiGatewayConfig) {
	nodeApp.use('*', createLokiGateway(lokiGatewayConfig, {
		resolveSiteKey: async (request) => (await staticSiteRouter.resolve(request))?.siteKey,
		trustedProxyRules,
	}));
}
nodeApp.use('*', compress());
nodeApp.use('*', etag());
nodeApp.use('*', async (c, next) => {
	if (!c.req.path.endsWith('.map')) return next();
	const clientIp = getClientIp(c, trustedProxyRules);
	if (!clientIp || !mapAllowedIps.has(clientIp)) return c.text('Not Found', 404);
	c.header('Cache-Control', 'no-cache');
	return next();
});
/**
 * 按站点覆盖静态站点：`wwwroot/<site_key>/` 下的文件优先于应用页面，
 * 用于给某个代码站点提供静态首页等内容；目录不存在时什么都不做。
 * 这是 Node 运行时特有的虚拟主机能力：Worker 的静态资源（ASSETS）只按路径匹配、不区分 Host，
 * 因此 Worker 部署下该域名仍然使用应用自身的首页。
 */
const wwwrootDirectory = fileURLToPath(new URL('../wwwroot/', import.meta.url));
const hostnamePattern = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const staticContentTypes: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
nodeApp.use('*', async (c, next) => {
	if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
	const url = new URL(c.req.url);
	const hostname = url.hostname.toLowerCase();
	if (!hostnamePattern.test(hostname) || hostname.includes('..')) return next();
	const site = await staticSiteRouter.resolve(c.req.raw);
	if (!site) return next();
	let requestPath: string;
	try { requestPath = decodeURIComponent(url.pathname); }
	catch { return next(); }
	if (requestPath.includes('..') || requestPath.includes('\0')) return next();
	const siteRoot = join(wwwrootDirectory, site.siteKey);
	const candidate = join(siteRoot, requestPath.endsWith('/') ? `${requestPath}index.html` : requestPath);
	if (candidate !== siteRoot && !candidate.startsWith(`${siteRoot}/`)) return next();
	const info = await stat(candidate).catch(() => undefined);
	const file = info?.isDirectory() ? join(candidate, 'index.html') : candidate;
	const fileInfo = info?.isDirectory() ? await stat(file).catch(() => undefined) : info;
	if (!fileInfo?.isFile()) return next();
	c.header('Content-Type', staticContentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream');
	c.header('Cache-Control', 'no-cache');
	return c.body(await readFile(file));
});

// 统一服务 public 下的静态文件；文件是否存在决定是否处理，不维护逐文件映射。
nodeApp.use('*', async (c, next) => {
	if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
	if (c.req.path.startsWith('/api/')) return next();
	let requestPath: string;
	try { requestPath = decodeURIComponent(c.req.path); } catch { return next(); }
	if (requestPath.includes('..') || requestPath.includes('\0')) return next();
	if (requestPath.endsWith('.nocache')) requestPath = requestPath.slice(0, -'.nocache'.length);
	const file = join(publicDir, requestPath === '/' ? 'index.html' : requestPath);
	const publicRoot = publicDir.endsWith('/') ? publicDir.slice(0, -1) : publicDir;
	if (!file.startsWith(`${publicRoot}/`)) return next();
	const info = await stat(file).catch(() => undefined);
	if (!info?.isFile()) return next();
	c.header('Cache-Control', 'no-cache');
	c.header('Content-Type', staticContentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream');
	return c.body(await readFile(file));
});

nodeApp.use('*', serveStatic({ root: publicDir }));
nodeApp.all('*', (c) => worker.fetch(c.req.raw, {
	DEFAULT_DB: defaultDatabase,
	// Preserve the Node socket for the shared trusted-proxy IP resolver.  The
	// Worker entry point otherwise only receives the Request object.
	incoming: (c.env as { incoming?: unknown } | undefined)?.incoming,
	SNOWFLAKE_WORKER_ID: workerId,
	SUPER_USER_IDS: superUserIds,
	DATABASE_RESOLVER: async (site) => {
		if (site.databaseTarget.kind === 'default') return defaultDatabase;
		if (site.databaseTarget.kind !== 'dsn') {
			throw new Error(`Node database target is not supported: ${site.databaseTarget.kind}`);
		}
		return resolveSiteDsn(site.databaseTarget.value);
	},
	MIGRATE_SITE: migrateSite,
	SITE_DATABASE: resolveSiteDsn,
	OIDC_FETCH: fetch,
} as WorkerBindings));

export const app = nodeApp;
/** CLI-only rescue entry. The HTTP application never exposes this function as a route. */
export const runMaintenanceAction = (action: string, input: Record<string, unknown> = {}) => executeMaintenanceAction(defaultDatabase, action, input);

const domain = systemConfig.domain || 'anan.cc';
const httpPort = Number(systemConfig.httpPort) || 80;
/**
 * 0 表示不开 HTTPS。默认 443：这个项目正常是自己直接对外服务，前面不放 Nginx。
 * 开发机上没有证书、也没有特权端口时，用 HTTPS_PORT=0 关掉，或 HTTP_PORT 换个高位端口。
 */
const httpsPort = Number(systemConfig.httpsPort) || 0;
const IPV4_ANY = '0.0.0.0';
const DUAL_STACK_ANY = '::';
/**
 * 默认绑 `::`，**一个套接字同时收 IPv6 和 IPv4**。
 *
 * Linux 的 `net.ipv6.bindv6only=0`（绝大多数发行版的默认）下，绑在 `::` 上的套接字也会
 * 收到 IPv4 连接，对端地址显示成 `::ffff:a.b.c.d` 的映射形式。因此不需要开两个监听，
 * 也就不会出现「两个监听抢同一个端口」那种只在某些内核配置下才复现的启动失败。
 *
 * 回落是必须的：有的环境把 IPv6 整个关了（`disable_ipv6=1`），或者把 `bindv6only` 设成 1
 * ——前者绑不上，后者绑上了却收不到 IPv4。两种情况下宁可只服务 IPv4，也不能一个都不收。
 * `HTTP_HOST` 可以显式钉死某一个地址，绕过这套判断。
 */
const listenHost = process.env.HTTP_HOST || DUAL_STACK_ANY;

const serveOn = (hostname: string, listenPort: number, extra: Record<string, unknown>) => new Promise<{ address: string; port: number }>((resolve, reject) => {
	const server = serve({ fetch: app.fetch, port: listenPort, hostname, ...extra }, (info) => resolve({ address: info.address, port: info.port }));
	server.once('error', reject);
});

/** 绑一个端口，带 IPv6 → IPv4 的回落。 */
const bindPort = async (listenPort: number, extra: Record<string, unknown>) => {
	try { return await serveOn(listenHost, listenPort, extra); }
	catch (error) {
		if (listenHost === IPV4_ANY) throw error;
		console.warn(`绑定 ${listenHost}:${listenPort} 失败，回落到 ${IPV4_ANY}（这台机器多半关掉了 IPv6）：${error instanceof Error ? error.message : String(error)}`);
		return serveOn(IPV4_ANY, listenPort, extra);
	}
};

/**
 * 证书从哪来，按**显式优先**排：
 *
 * 1. `HTTPS_KEY_FILE` / `HTTPS_CERT_FILE` —— 运维明确指到哪就用哪，不再猜。
 * 2. acme.sh 按域名签的那份（`~/.acme.sh/<域名>_ecc/`）——正常生产路径。
 * 3. `certs/self-signed.{key,crt}` —— `npm run cert:self-signed` 生成的自签证书。
 *
 * 自签**只用来把 443 跑起来**：浏览器会红锁，回源的 CDN 也必须关掉源站证书校验。
 * 它解决的是「443 上什么都没有」，不是「443 上有可信的东西」，两者别混。
 */
const readCertificate = async (): Promise<{ key: Buffer; cert: Buffer; source: string } | undefined> => {
	const candidates: Array<{ key: string; cert: string; source: string }> = [];
	if (env.HTTPS_KEY_FILE && env.HTTPS_CERT_FILE) candidates.push({ key: env.HTTPS_KEY_FILE, cert: env.HTTPS_CERT_FILE, source: 'HTTPS_KEY_FILE/HTTPS_CERT_FILE' });
	const acmeDir = join(homedir(), '.acme.sh', `${domain}_ecc`);
	candidates.push({ key: join(acmeDir, `${domain}.key`), cert: join(acmeDir, 'fullchain.cer'), source: `acme.sh（${domain}）` });
	candidates.push({ key: resolve(projectDirectory, 'certs/self-signed.key'), cert: resolve(projectDirectory, 'certs/self-signed.crt'), source: '自签证书' });
	for (const candidate of candidates) {
		try { return { key: await readFile(candidate.key), cert: await readFile(candidate.cert), source: candidate.source }; }
		catch { /* 这一份不在就试下一份；三份都没有才算没有证书。 */ }
	}
	return undefined;
};

const describeAddress = (address: string) => address === DUAL_STACK_ANY ? '[::]（同时接受 IPv4）'
	: address === IPV4_ANY ? `${IPV4_ANY}（仅 IPv4）`
		: address;

/**
 * **HTTP 与 HTTPS 是两个端口，不再是「有证书就把那一个端口变成 HTTPS」。**
 *
 * 原先的写法是：证书读到了就在 `httpPort` 上跑 TLS，读不到就跑明文——于是同一个端口号
 * 的协议取决于磁盘上有没有文件，而且永远只能二选一。要 80 和 443 同时服务就做不到。
 * 现在 `httpPort` 恒为明文、`httpsPort` 恒为 TLS，各自独立；`httpsPort` 为 0 就是不开。
 *
 * 明文那一个先起：回源的 CDN 通常打明文，它挂了站点就整个不可达，而证书缺失只影响 443。
 */
const listen = async () => {
	const plain = await bindPort(httpPort, {});
	console.log(`HTTP/1 Listening on ${describeAddress(plain.address)}:${plain.port}`);
	if (!httpsPort) return;
	const certificate = await readCertificate();
	if (!certificate) {
		// 说清楚缺什么、怎么补：这条日志的读者正是那个以为 443 已经开了的人。
		console.warn(`HTTPS 端口 ${httpsPort} 已配置，但没有找到证书，跳过 HTTPS。生成自签证书：npm run cert:self-signed`);
		return;
	}
	try {
		const secure = await bindPort(httpsPort, { createServer: createSecureServer, serverOptions: secureServerOptions(certificate) });
		console.log(`HTTP/2 Listening on ${describeAddress(secure.address)}:${secure.port}（证书来自${certificate.source}）`);
	} catch (error) {
		// HTTPS 起不来不能把明文也带走：那会把一个「443 不通」放大成「整站不通」。
		console.error(`HTTPS 监听失败，明文端口不受影响：${error instanceof Error ? error.message : String(error)}`);
	}
};

/**
 * 审计保留期清理。本进程里没有调度器，因此启动跑一次、之后每 6 小时跑一次；
 * 清理本身分批且可重入（§10），漏跑一轮只是记录多留一会儿，不会出错。
 * Workers 部署没有常驻进程，要改用 cron 触发器调用 purgeAuditRetention。
 */
const auditRetentionInterval = 6 * 60 * 60 * 1000;
const runAuditRetention = () => {
	purgeAuditRetention(defaultDatabase)
		.then((removed) => { if (removed) console.log(`audit retention: purged ${removed} entries`); })
		.catch((error) => console.error('audit retention failed', error));
};
if (!skipStartupChecks) {
	runAuditRetention();
	setInterval(runAuditRetention, auditRetentionInterval).unref();
}

/**
 * 短信推送投递。本进程里没有调度器，因此每 30 秒跑一轮，理由与上面的保留期清理相同；
 * Workers 部署要改用 cron 触发器调用 dispatchPushDeliveries。
 *
 * **一轮有上限**，不把积压一次发完：投递是对外的 HTTP，几百个并发出去对面会把本站当成
 * 攻击源。漏发的下一轮继续，`next_attempt_at` 记着该什么时候再试。
 *
 * 只扫默认库——与保留期清理一样的限制：多库部署时各站点库要各自调度。
 */
const pushDispatchInterval = 30 * 1000;
const runPushDispatch = () => {
	dispatchPushDeliveries(defaultDatabase)
		.then((result) => { if (result.sent || result.failed) console.log(`sms push: sent ${result.sent}, failed ${result.failed}`); })
		.catch((error) => console.error('sms push dispatch failed', error));
};
if (!skipStartupChecks) setInterval(runPushDispatch, pushDispatchInterval).unref();

if (process.env.SKIP_SERVER_LISTEN !== '1') await listen();
