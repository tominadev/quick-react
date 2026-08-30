let fingerprintPromise: Promise<string> | undefined;
let networkInfoPromise: Promise<string> | undefined;
let deviceKeyPromise: Promise<string> | undefined;

const sha256Hex = async (value: string) => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const crc32 = (value: string) => {
	let crc = 0xffffffff;
	for (const byte of new TextEncoder().encode(value)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

const computeFingerprint = async () => {
	const canvas = document.createElement('canvas');
	canvas.width = 220; canvas.height = 30;
	const context = canvas.getContext('2d');
	if (!context) return '';
	context.textBaseline = 'top';
	context.font = '14px Arial';
	context.fillStyle = '#f60';
	context.fillRect(0, 0, 220, 30);
	context.fillStyle = '#069';
	context.fillText('fingerprint-check', 2, 2);
	return JSON.stringify({ canvas_crc32: crc32(canvas.toDataURL()) });
};

export const getDeviceFingerprint = () => {
	if (!fingerprintPromise) fingerprintPromise = computeFingerprint().catch(() => '');
	return fingerprintPromise;
};

const isIpAddress = (value: string) => {
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255);
	return value.includes(':') && /^[0-9a-f:]+$/i.test(value);
};

/** Collect optional WebRTC candidate addresses once per page. */
const collectWebRtcIps = async () => {
	if (typeof RTCPeerConnection === 'undefined') return '';
	let peer: RTCPeerConnection | undefined;
	try {
		peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
		const addresses = new Set<string>();
		const finished = new Promise<void>((resolve) => {
			const timer = window.setTimeout(resolve, 1200);
			peer!.onicecandidate = (event) => {
				const candidate = event.candidate?.candidate;
				if (!candidate) { window.clearTimeout(timer); resolve(); return; }
				const address = event.candidate?.address || candidate.split(' ')[4];
				if (address && isIpAddress(address)) addresses.add(address);
			};
		});
		peer.createDataChannel('device-network');
		await peer.setLocalDescription(await peer.createOffer());
		await finished;
		return [...addresses].slice(0, 8).join(',');
	} catch {
		return '';
	} finally {
		peer?.close();
	}
};

export const getDeviceNetworkInfo = () => {
	if (!networkInfoPromise) networkInfoPromise = collectWebRtcIps().catch(() => '');
	return networkInfoPromise;
};

const readStoredDeviceKey = () => {
	try {
		const value = window.localStorage.getItem('quick_react_device_key')?.trim() ?? '';
		return /^[a-f0-9]{64}$/.test(value) ? value : '';
	} catch {
		return '';
	}
};

const storeDeviceKey = (value: string) => {
	try { window.localStorage.setItem('quick_react_device_key', value); return true; }
	catch { return false; }
};

/** Generate and persist the per-origin device identifier exactly once. */
const computeDeviceKey = async () => {
	const stored = readStoredDeviceKey();
	if (stored) return stored;
	const [fingerprint, networkInfo] = await Promise.all([getDeviceFingerprint(), getDeviceNetworkInfo()]);
	const collected = {
		fingerprint: JSON.parse(fingerprint),
		webrtc_ips: networkInfo ? networkInfo.split(',').filter(Boolean) : [],
		user_agent: navigator.userAgent,
		platform: navigator.platform,
		language: navigator.language,
		screen_width: window.screen.width,
		screen_height: window.screen.height,
	};
	const entropy = `${JSON.stringify(collected)}${new Date().getTime()}${Math.random().toString().substring(2)}`;
	const key = await sha256Hex(entropy);
	return storeDeviceKey(key) ? key : '';
};

export const getDeviceKey = () => {
	if (!deviceKeyPromise) deviceKeyPromise = computeDeviceKey().catch(() => '');
	return deviceKeyPromise;
};

/** Build the common device headers used by all browser-to-server requests. */
export const getDeviceHeaders = async (init?: HeadersInit) => {
	const [deviceKey, fingerprint, networkInfo] = await Promise.all([getDeviceKey(), getDeviceFingerprint(), getDeviceNetworkInfo()]);
	const headers = new Headers(init);
	if (deviceKey) headers.set('X-Device-Key', deviceKey);
	if (fingerprint) headers.set('X-Device-Fingerprint', fingerprint);
	if (networkInfo) headers.set('X-WebRTC-IPs', networkInfo);
	return headers;
};
