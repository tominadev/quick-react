export const deviceKeyTransportCookieName = 'quick_react_device_key_transport';
export const deviceFingerprintTransportCookieName = 'quick_react_device_fingerprint_transport';
const deviceKeyPattern = /^[a-f0-9]{64}$/;

/**
 * OAuth/外部登录会经过第三方页面，浏览器导航无法附加自定义请求头。
 * API 响应会把本次请求的设备键和 fingerprint 临时放入 HttpOnly Cookie，仅用于把它们带到回调，
 * 设备键的正式存储位置仍然是当前站点 localStorage。
 */
export const createDeviceKeyTransportCookie = (value: string, secure: boolean) => deviceKeyPattern.test(value)
	? `${deviceKeyTransportCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`
	: '';
export const clearDeviceKeyTransportCookie = (secure: boolean) => `${deviceKeyTransportCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
export const clearDeviceFingerprintTransportCookie = (secure: boolean) => `${deviceFingerprintTransportCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

const cookieValue = (request: Request, name: string) => request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
const decodeCookie = (value: string) => { try { return decodeURIComponent(value); } catch { return ''; } };

/** 设备唯一键只接受客户端生成的 SHA-256（小写十六进制）结果。 */
export const readDeviceKey = (request: Request) => {
	const header = request.headers.get('x-device-key')?.trim() ?? '';
	const value = header || decodeCookie(cookieValue(request, deviceKeyTransportCookieName));
	if (!deviceKeyPattern.test(value)) throw new Error('设备标识无效，请刷新页面后重试');
	return value;
};

/** 设备 fingerprint 是独立的 JSON 证据，不参与设备唯一性判断。 */
const parseDeviceFingerprint = (value: string) => {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new Error('设备指纹数据无效，请刷新页面后重试'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设备指纹数据无效，请刷新页面后重试');
	const canvasCrc32 = (parsed as Record<string, unknown>).canvas_crc32;
	if (typeof canvasCrc32 !== 'string' || !/^[a-f0-9]{8}$/.test(canvasCrc32)) throw new Error('设备指纹数据无效，请刷新页面后重试');
	return JSON.stringify(parsed);
};
export const readDeviceFingerprint = (request: Request) => parseDeviceFingerprint(request.headers.get('x-device-fingerprint')?.trim() || decodeCookie(cookieValue(request, deviceFingerprintTransportCookieName)));

/** 将请求头中的 fingerprint 临时交给 OAuth/外部回调导航使用。 */
export const createDeviceFingerprintTransportCookie = (value: string, secure: boolean) => {
	try {
		return `${deviceFingerprintTransportCookieName}=${encodeURIComponent(parseDeviceFingerprint(value))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
	} catch { return ''; }
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
