/** 设备指纹只接受客户端生成的 SHA-256（小写十六进制）结果。 */
export const readDeviceFingerprint = (request: Request) => {
	const header = request.headers.get('x-device-fingerprint')?.trim() ?? '';
	const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('passport_device_fingerprint='))?.slice('passport_device_fingerprint='.length) ?? '';
	const value = header || cookie;
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('设备指纹无效，请刷新页面后重试');
	return value;
};

export const requestDeviceSnapshot = (request: Request) => ({
	user_agent: request.headers.get('user-agent') ?? '',
	platform: request.headers.get('sec-ch-ua-platform') ?? '',
	ip_address: request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '',
});
