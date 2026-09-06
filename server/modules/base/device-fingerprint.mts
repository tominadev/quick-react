import { deviceKeyPattern, normalizeDeviceKey } from '@shared/device-key.mjs';

/** 浏览器导航和 OAuth 回调使用的 HttpOnly 设备键 Cookie；它不是会话凭证。 */
export const deviceKeyTransportCookieName = 'device_key';
export const createDeviceKeyTransportCookie = (value: string, secure: boolean) => deviceKeyPattern.test(normalizeDeviceKey(value))
	? `${deviceKeyTransportCookieName}=${encodeURIComponent(normalizeDeviceKey(value))}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
	: '';

const cookieValue = (request: Request, name: string) => request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
const decodeCookie = (value: string) => { try { return decodeURIComponent(value); } catch { return ''; } };

/** 设备唯一键由客户端生成，格式见 `@shared/device-key.mjs`。 */
export const readOptionalDeviceKey = (request: Request) => {
	const header = request.headers.get('x-device-key')?.trim() ?? '';
	const raw = header || decodeCookie(cookieValue(request, deviceKeyTransportCookieName));
	if (!raw) return undefined;
	// 先归一再校验：UUID 与 32 位十六进制是同一个东西，只差连字符。老客户端发的带连字符
	// 写法在这里收敛成同一个值，否则同一台设备会被记成两台。
	const value = normalizeDeviceKey(raw);
	if (!deviceKeyPattern.test(value)) throw new Error('设备标识无效，请刷新页面后重试');
	return value;
};

export const readDeviceKey = (request: Request) => {
	const value = readOptionalDeviceKey(request);
	if (!value) throw new Error('设备标识无效，请刷新页面后重试');
	return value;
};

/** 设备 fingerprint 是独立的 JSON 证据，不参与设备唯一性判断。 */
const parseDeviceFingerprint = (value: string) => {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new Error('设备指纹数据无效，请刷新页面后重试'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设备指纹数据无效，请刷新页面后重试');
	const evidence = parsed as Record<string, unknown>;
	const isCyrb53 = (candidate: unknown) => {
		if (typeof candidate !== 'string' || !/^(?:0|[1-9a-f][0-9a-f]{0,13})$/.test(candidate)) return false;
		try { return BigInt(`0x${candidate}`) <= 0x1fffffffffffffn; }
		catch { return false; }
	};
	if (!isCyrb53(evidence.canvas_cyrb53) || (evidence.audio_cyrb53 !== undefined && !isCyrb53(evidence.audio_cyrb53))) throw new Error('设备指纹数据无效，请刷新页面后重试');
	return JSON.stringify(parsed);
};
/**
 * fingerprint 只通过前端请求头提交；第三方 OAuth 回调没有自定义请求头时允许缺省。
 * 它是设备分析证据，不是认证凭证，缺省时由设备写入逻辑保留原值或使用空对象初始化。
 */
export const readDeviceFingerprint = (request: Request) => {
	const value = request.headers.get('x-device-fingerprint')?.trim() ?? '';
	return value ? parseDeviceFingerprint(value) : undefined;
};

const networkHeaders = [
	['forwarded', 'forwarded'],
	['x-real-ip', 'x_real_ip'],
	['x-forwarded-for', 'x_forwarded_for'],
	['cf-connecting-ip', 'cf_connecting_ip'],
	['cf-connecting-ipv6', 'cf_connecting_ipv6'],
	['eo-connecting-ip', 'eo_connecting_ip'],
	['ali-cdn-real-ip', 'ali_cdn_real_ip'],
	['x-webrtc-ips', 'webrtc_ips'],
] as const;

const nonEmpty = (value: string | null | undefined) => {
	const normalized = value?.trim();
	return normalized || undefined;
};

const unquote = (value: string | null | undefined) => {
	const normalized = nonEmpty(value);
	if (!normalized) return '';
	return normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')
		? normalized.slice(1, -1)
		: normalized;
};

/**
 * Returns the best IP already resolved by the trusted proxy layer.  When a
 * caller does not have the Hono context (for example a Worker request), use
 * the provider headers as a storage fallback so the original evidence is not
 * lost; the complete raw values are always retained in network_info.
 */
const fallbackRealIp = (request: Request) => {
	const candidates = [
		request.headers.get('cf-connecting-ip'),
		request.headers.get('eo-connecting-ip'),
		request.headers.get('ali-cdn-real-ip'),
		request.headers.get('x-real-ip'),
		request.headers.get('x-forwarded-for')?.split(',')[0],
	];
	return candidates.map(nonEmpty).find(Boolean) ?? '';
};

/**
 * Device network evidence is deliberately a flat map of raw request values.
 * Empty values are omitted, derived `resolved_*` fields are not stored, and
 * `true_client_ip` is intentionally not treated as a separate field.
 */
export const requestDeviceSnapshot = (request: Request, resolvedIp?: string, transportIp?: string) => {
	const networkInfo: Record<string, string | string[]> = {};
	const directIp = nonEmpty(transportIp);
	if (directIp) networkInfo.transport_ip = directIp;
	for (const [header, key] of networkHeaders) {
		const value = nonEmpty(request.headers.get(header));
		if (!value) continue;
		if (key === 'webrtc_ips') {
			const addresses = value.split(',').map((address) => address.trim()).filter(Boolean);
			if (addresses.length) networkInfo[key] = [...new Set(addresses)];
		} else networkInfo[key] = value;
	}
	return {
		user_agent: request.headers.get('user-agent') ?? '',
		platform: unquote(request.headers.get('sec-ch-ua-platform')),
		// `ip_address` is the single current/resolved IP; raw proxy and WebRTC
		// evidence stays in the flat JSON map above for later analysis.
		ip_address: nonEmpty(resolvedIp) ?? fallbackRealIp(request),
		network_info: JSON.stringify(networkInfo),
	};
};
