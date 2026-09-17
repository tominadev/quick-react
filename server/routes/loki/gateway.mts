/**
 * 日志中心网关站点。
 *
 * 这个代码站点不提供页面和 API，只做一件事：把绑定到它的域名代理给本机的 Loki 和 Grafana。
 * 因此目录下没有 `api/` 和 `navigation.mts`——注册成代码站点只是为了能在站点管理里
 * 给它绑定域名（`global_site_hosts`），换域名不用改代码。
 *
 * 为什么需要这一层：Loki 在单租户模式下 `auth_enabled: false`，自身没有任何认证，
 * 谁连上谁就能写日志、读全部日志、调删除接口。它的设计前提就是前面有网关负责鉴权。
 * 所以这里做三件事：推送接口校验 Basic 认证、Loki 的其余接口一律拒绝、其余路径给 Grafana。
 * 大屏查询不走这条路——Grafana 在服务器内部直连 Loki，不经过公网。
 *
 * 只在 Node 运行时装配：Worker 运行时连不到 127.0.0.1 上的进程。
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getClientIp } from '../../modules/base/client-ip.mjs';
import type { AppEnv } from '../../modules/base/types.mjs';

/** 站点键与本目录同名；域名绑到这个站点即启用网关。 */
export const LOKI_SITE_KEY = 'loki';

export type LokiGatewayConfig = {
	/** 推送接口路径，必须与源站 Alloy 配置里的 url 一致。 */
	pushPath: string;
	lokiOrigin: string;
	grafanaOrigin: string;
	pushUser: string;
	pushPassword: string;
};

const DEFAULT_PUSH_PATH = '/loki/api/v1/push';
const DEFAULT_LOKI_ORIGIN = 'http://127.0.0.1:3100';
const DEFAULT_GRAFANA_ORIGIN = 'http://127.0.0.1:3000';
/** 大屏查长时间范围时 Grafana 可能要跑很久，按 Loki 自己的 http_server_*_timeout 取 5 分钟。 */
const UPSTREAM_TIMEOUT_MS = 300_000;

/** 逐跳首部不能转发，否则上游会看到一个不属于这一跳连接的 Connection/Upgrade 语义。 */
const HOP_BY_HOP_HEADERS = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export const loadLokiGatewayConfig = (values: Record<string, string | undefined>): LokiGatewayConfig | undefined => {
	const read = (key: string) => String(values[key] ?? '').trim();
	const pushUser = read('LOKI_PUSH_USER');
	const pushPassword = read('LOKI_PUSH_PASSWORD');
	// 没配账号密码就不装配网关。宁可这个域名打不开，也不能把一个无鉴权、
	// 可读可写可删的日志库直接转发到公网上。
	if (!pushUser || !pushPassword) return undefined;
	return {
		pushPath: read('LOKI_PUSH_PATH') || DEFAULT_PUSH_PATH,
		lokiOrigin: read('LOKI_ORIGIN') || DEFAULT_LOKI_ORIGIN,
		grafanaOrigin: read('GRAFANA_ORIGIN') || DEFAULT_GRAFANA_ORIGIN,
		pushUser,
		pushPassword,
	};
};

const equalsInConstantTime = (left: string, right: string) => {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	// timingSafeEqual 要求等长；长度不同直接判否，只泄漏长度本身。
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const isAuthorized = (header: string | undefined, config: LokiGatewayConfig) => {
	if (!header?.toLowerCase().startsWith('basic ')) return false;
	let decoded: string;
	try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
	catch { return false; }
	const separator = decoded.indexOf(':');
	if (separator < 0) return false;
	const user = equalsInConstantTime(decoded.slice(0, separator), config.pushUser);
	const password = equalsInConstantTime(decoded.slice(separator + 1), config.pushPassword);
	// 两个都算完再取与：先判用户名会让「用户名对不对」从耗时上被看出来。
	return user && password;
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

const proxyTo = async (c: Context<AppEnv>, origin: string, headers: Headers) => {
	const url = new URL(c.req.url);
	const target = new URL(`${url.pathname}${url.search}`, origin);
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
	options: { resolveSiteKey: (request: Request) => Promise<string | undefined>; trustedProxyRules: string[] },
) => async (c: Context<AppEnv>, next: Next) => {
	const siteKey = await options.resolveSiteKey(c.req.raw).catch(() => undefined);
	if (siteKey !== LOKI_SITE_KEY) return next();

	const path = new URL(c.req.url).pathname;
	const clientIp = getClientIp(c, options.trustedProxyRules) ?? '';

	if (path === config.pushPath) {
		if (c.req.method !== 'POST') return c.text('Method Not Allowed', 405);
		if (!isAuthorized(c.req.header('authorization'), config)) {
			return c.body('Unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="loki"' });
		}
		// 认证在这一跳就结束，不把凭据继续递给 Loki。
		return proxyTo(c, config.lokiOrigin, forwardedHeaders(c, { authorization: '', 'x-forwarded-for': clientIp }));
	}

	// Loki 的其余接口（查询、标签、删除）不对外开放：源站只需要写入。
	if (path === '/loki' || path.startsWith('/loki/')) return c.text('Forbidden', 403);

	return proxyTo(c, config.grafanaOrigin, forwardedHeaders(c, {
		'x-forwarded-for': clientIp,
		'x-real-ip': clientIp,
		'x-forwarded-proto': new URL(c.req.url).protocol.replace(':', ''),
	}));
};
