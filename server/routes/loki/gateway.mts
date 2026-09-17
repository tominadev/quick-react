/**
 * 日志中心网关站点。
 *
 * 这个代码站点不提供页面和 API，只做一件事：把绑定到它的域名代理给本机的 Loki 和 Grafana。
 * 因此目录下没有 `api/` 和 `navigation.mts`——注册成代码站点只是为了能在站点管理里
 * 给它绑定域名（`global_site_hosts`），换域名不用改代码。
 *
 * 为什么需要这一层：Loki 自身不做认证，它认的是 `X-Scope-OrgID` 说自己是哪个租户——
 * 谁能连上它，谁就能指定任意租户写入和读取。它的设计前提就是前面有网关负责鉴权。
 * 所以这里做三件事：推送接口按源站凭据认证并据此注入租户、Loki 的其余接口一律拒绝、
 * 其余路径给 Grafana。大屏查询不走这条路——Grafana 在服务器内部直连 Loki，不经过公网。
 *
 * 只在 Node 运行时装配：Worker 运行时连不到 127.0.0.1 上的进程。
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getClientIp } from '../../modules/base/client-ip.mjs';
import type { AppEnv } from '../../modules/base/types.mjs';
import type { DatabaseAdapter } from '../../database/index.mjs';
import type { SiteRequestContext } from '../../modules/base/site-router.mjs';
import { findSourceByPushUser, hashPushSecret, touchSource, type SourceCredential } from './sources.mjs';
import { heartbeatAgent, registerAgent } from './agent.mjs';

/** 站点键与本目录同名；域名绑到这个站点即启用网关。 */
export const LOKI_SITE_KEY = 'loki';

export type LokiGatewayConfig = {
	/** 日志推送接口路径，必须与源站 Alloy 配置里的 url 一致。 */
	pushPath: string;
	/** 指标推送接口路径（Prometheus remote write）。 */
	metricsPushPath: string;
	lokiOrigin: string;
	mimirOrigin: string;
	grafanaOrigin: string;
};

const DEFAULT_PUSH_PATH = '/loki/api/v1/push';
const DEFAULT_METRICS_PUSH_PATH = '/prom/api/v1/push';
const DEFAULT_LOKI_ORIGIN = 'http://127.0.0.1:3100';
const DEFAULT_MIMIR_ORIGIN = 'http://127.0.0.1:9009';
const DEFAULT_GRAFANA_ORIGIN = 'http://127.0.0.1:3000';
/** Mimir 自己的远程写入路径；对外用 /prom/ 前缀是为了和 Loki 的 /loki/ 对称。 */
const MIMIR_PUSH_PATH = '/api/v1/push';
const AGENT_REGISTER_PATH = '/agent/register';
const AGENT_HEARTBEAT_PATH = '/agent/heartbeat';
/** 大屏查长时间范围时 Grafana 可能要跑很久，按 Loki 自己的 http_server_*_timeout 取 5 分钟。 */
const UPSTREAM_TIMEOUT_MS = 300_000;

/** 逐跳首部不能转发，否则上游会看到一个不属于这一跳连接的 Connection/Upgrade 语义。 */
const HOP_BY_HOP_HEADERS = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export const loadLokiGatewayConfig = (values: Record<string, string | undefined>): LokiGatewayConfig => {
	const read = (key: string) => String(values[key] ?? '').trim();
	return {
		pushPath: read('LOKI_PUSH_PATH') || DEFAULT_PUSH_PATH,
		metricsPushPath: read('METRICS_PUSH_PATH') || DEFAULT_METRICS_PUSH_PATH,
		lokiOrigin: read('LOKI_ORIGIN') || DEFAULT_LOKI_ORIGIN,
		mimirOrigin: read('MIMIR_ORIGIN') || DEFAULT_MIMIR_ORIGIN,
		grafanaOrigin: read('GRAFANA_ORIGIN') || DEFAULT_GRAFANA_ORIGIN,
	};
};

const equalsInConstantTime = (left: string, right: string) => {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	// timingSafeEqual 要求等长；长度不同直接判否，只泄漏长度本身。
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const parseBasicAuth = (header: string | undefined) => {
	if (!header?.toLowerCase().startsWith('basic ')) return undefined;
	let decoded: string;
	try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
	catch { return undefined; }
	const separator = decoded.indexOf(':');
	if (separator < 0) return undefined;
	return { user: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
};

/**
 * 源站记录的短期缓存。每条推送都查一次库没必要——源站每秒都在推，而启用状态和密钥
 * 很少变；命中未知用户名也缓存，否则拿随机用户名刷接口就是在刷数据库。
 */
const CREDENTIAL_CACHE_TTL_MS = 10_000;
/** 最后活跃时间的写库间隔。这一列只用来判断源站是否还活着，不需要每次推送都更新。 */
const LAST_SEEN_INTERVAL_MS = 60_000;

const createSourceLookup = () => {
	const cache = new Map<string, { expiresAt: number; source?: SourceCredential }>();
	const lastSeenWrites = new Map<string, number>();
	return {
		async find(database: DatabaseAdapter, pushUser: string) {
			const now = Date.now();
			const cached = cache.get(pushUser);
			if (cached && cached.expiresAt > now) return cached.source;
			const source = await findSourceByPushUser(database, pushUser);
			cache.set(pushUser, { expiresAt: now + CREDENTIAL_CACHE_TTL_MS, source });
			// 缓存只按用户名增长，而用户名来自请求；清掉过期项，避免被随机用户名撑大。
			if (cache.size > 1000) for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
			return source;
		},
		async touch(database: DatabaseAdapter, source: SourceCredential) {
			const now = Date.now();
			if ((lastSeenWrites.get(source.id) ?? 0) + LAST_SEEN_INTERVAL_MS > now) return;
			lastSeenWrites.set(source.id, now);
			await touchSource(database, source.id)
				.catch((error) => console.error(`更新源站最后活跃时间失败：${error instanceof Error ? error.message : String(error)}`));
		},
	};
};

const forwardedHeaders = (c: Context<AppEnv>, extra: Record<string, string>) => {
	const headers = new Headers();
	c.req.raw.headers.forEach((value, key) => {
		if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	});
	for (const [key, value] of Object.entries(extra)) {
		if (value) headers.set(key, value);
		else headers.delete(key);
	}
	return headers;
};

const proxyTo = async (c: Context<AppEnv>, origin: string, headers: Headers, rewritePath?: string) => {
	const url = new URL(c.req.url);
	const target = new URL(`${rewritePath ?? url.pathname}${url.search}`, origin);
	const method = c.req.method;
	// 请求体先读进内存再转发：Alloy 每批最大 1MB，Grafana 的接口请求更小。
	// 流式转发需要 duplex 半双工支持，收益不值得为这点体量引入。
	const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer();
	let upstream: Response;
	try {
		upstream = await fetch(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	} catch (error) {
		// 上游没起来或超时：返回 502，并且不把内部地址写进响应体。
		console.error(`日志中心网关回源失败 ${method} ${target.pathname}：${error instanceof Error ? error.message : String(error)}`);
		return c.text('Bad Gateway', 502);
	}
	const responseHeaders = new Headers();
	upstream.headers.forEach((value, key) => {
		const name = key.toLowerCase();
		// content-encoding / content-length 必须丢掉：fetch 已经把 gzip 解开了，
		// 原来的首部与实际转发的字节不再对应，照抄会让浏览器解不出内容。
		if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-encoding' || name === 'content-length') return;
		responseHeaders.append(key, value);
	});
	return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};

/**
 * 网关中间件。绑定到本站点的域名由它处理，其余域名原样交给后面的中间件。
 */
export const createLokiGateway = (
	config: LokiGatewayConfig,
	options: {
		resolveSite: (request: Request) => Promise<SiteRequestContext | undefined>;
		resolveDatabase: (site: SiteRequestContext) => Promise<DatabaseAdapter>;
		trustedProxyRules: string[];
	},
) => {
	const sources = createSourceLookup();
	return async (c: Context<AppEnv>, next: Next) => {
		const site = await options.resolveSite(c.req.raw).catch(() => undefined);
		if (site?.siteKey !== LOKI_SITE_KEY) return next();

		const path = new URL(c.req.url).pathname;
		const clientIp = getClientIp(c, options.trustedProxyRules) ?? '';

		const unauthorized = () => c.body('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="loki"' });
		/** 推送和心跳共用同一份源站凭据：一台机器一份，认出来的同时也就知道了它属于哪个租户。 */
		const authenticate = async () => {
			const credentials = parseBasicAuth(c.req.header('authorization'));
			if (!credentials) return undefined;
			const database = await options.resolveDatabase(site).catch(() => undefined);
			if (!database) return undefined;
			const source = await sources.find(database, credentials.user).catch((error) => {
				console.error(`查询源站凭据失败：${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
			// 用户名不存在和密码错误返回同一个 401：区分开等于提供一个账号探测接口。
			// 停用的源站也一样——它不该能写入，也不必告诉对方原因。
			if (!source?.enabled || !equalsInConstantTime(await hashPushSecret(credentials.secret), source.pushSecretHash)) return undefined;
			return { database, source };
		};

		// 采集端注册：拿注册令牌换这台机器专属的凭据。令牌本身就是这里的认证，不需要 Basic。
		if (path === AGENT_REGISTER_PATH) {
			if (c.req.method !== 'POST') return c.text('Method Not Allowed', 405);
			const database = await options.resolveDatabase(site).catch(() => undefined);
			if (!database) return c.text('Service Unavailable', 503);
			const body = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
			const enrollToken = String(body?.token ?? '').trim();
			if (!enrollToken) return c.json({ error: '缺少注册令牌' }, 401);
			const registered = await registerAgent(database, {
				enrollToken,
				hostname: String(body?.hostname ?? ''),
				fingerprint: JSON.stringify(body?.fingerprint ?? {}),
			}).catch((error) => {
				console.error(`采集端注册失败：${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
			if (!registered) return c.json({ error: '注册令牌无效、已停用或已用完' }, 401);
			return c.json({ host: registered.host, push_user: registered.pushUser, push_secret: registered.pushSecret, agent_token: registered.agentToken });
		}

		// 心跳：轮换身份令牌，顺便识别克隆。
		if (path === AGENT_HEARTBEAT_PATH) {
			if (c.req.method !== 'POST') return c.text('Method Not Allowed', 405);
			const authenticated = await authenticate();
			if (!authenticated) return unauthorized();
			const body = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
			const result = await heartbeatAgent(authenticated.database, {
				sourceId: authenticated.source.id,
				agentToken: String(body?.agent_token ?? ''),
				retry: body?.retry === true,
				hostname: String(body?.hostname ?? ''),
				fingerprint: JSON.stringify(body?.fingerprint ?? {}),
			}).catch((error) => {
				console.error(`采集端心跳失败：${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
			if (!result) return c.json({ error: '心跳处理失败' }, 500);
			if (result.kind === 'rotated') return c.json({ agent_token: result.agentToken });
			return c.json({
				cloned: true,
				host: result.credentials.host,
				push_user: result.credentials.pushUser,
				push_secret: result.credentials.pushSecret,
				agent_token: result.credentials.agentToken,
			});
		}

		// 日志和指标走同一套凭据与租户注入，只是上游不同。
		const pushTarget = path === config.pushPath ? { origin: config.lokiOrigin, rewrite: undefined }
			: path === config.metricsPushPath ? { origin: config.mimirOrigin, rewrite: MIMIR_PUSH_PATH }
				: undefined;

		if (pushTarget) {
			// 先认证再判方法：没通过认证的客户端连「这个接口只收 POST」都不该知道。
			const authenticated = await authenticate();
			if (!authenticated) return unauthorized();
			const { database, source } = authenticated;
			if (c.req.method !== 'POST') return c.text('Method Not Allowed', 405);
			void sources.touch(database, source);
			// 租户由凭据推出，不接受采集端自报：自报等于任何一台源站都能写进别的租户。
			// 同名请求头一并覆盖掉，伪造的 X-Scope-OrgID 不会跟着转发出去。
			// 认证也在这一跳结束，不把凭据继续递给上游。
			return proxyTo(c, pushTarget.origin, forwardedHeaders(c, {
				authorization: '',
				'x-scope-orgid': source.tenantId,
				'x-forwarded-for': clientIp,
			}), pushTarget.rewrite);
		}

		// Loki 和 Mimir 的其余接口（查询、标签、删除、管理）不对外开放：源站只需要写入。
		if (path === '/loki' || path.startsWith('/loki/')) return c.text('Forbidden', 403);
		if (path === '/prom' || path.startsWith('/prom/')) return c.text('Forbidden', 403);

		return proxyTo(c, config.grafanaOrigin, forwardedHeaders(c, {
			'x-forwarded-for': clientIp,
			'x-real-ip': clientIp,
			'x-forwarded-proto': new URL(c.req.url).protocol.replace(':', ''),
		}));
	};
};
