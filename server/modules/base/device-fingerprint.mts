/** 设备指纹只接受客户端生成的 SHA-256（小写十六进制）结果。 */
export const readDeviceFingerprint = (request: Request) => {
	const header = request.headers.get('x-device-fingerprint')?.trim() ?? '';
	const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('passport_device_fingerprint='))?.slice('passport_device_fingerprint='.length) ?? '';
	const value = header || cookie;
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('设备指纹无效，请刷新页面后重试');
	return value;
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
