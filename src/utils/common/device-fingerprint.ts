let fingerprintPromise: Promise<string> | undefined;
let networkInfoPromise: Promise<string> | undefined;
let deviceKeyPromise: Promise<string> | undefined;
const deviceKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Stable 53-bit hash used for browser feature evidence. It is not a device key. */
const cyrb53 = (value: string, seed = 0) => {
	let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < value.length; index += 1) {
		const character = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ character, 2654435761);
		h2 = Math.imul(h2 ^ character, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const audioFingerprint = (): Promise<string | undefined> => new Promise((resolve) => {
	try {
		const Ctx = window.OfflineAudioContext || (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
		if (!Ctx) return resolve(undefined);
		const context = new Ctx(1, 44100, 44100);
		const oscillator = context.createOscillator();
		const compressor = context.createDynamicsCompressor();
		oscillator.type = 'triangle';
		oscillator.frequency.setValueAtTime(10000, context.currentTime);
		compressor.threshold.setValueAtTime(-50, context.currentTime);
		compressor.knee.setValueAtTime(40, context.currentTime);
		compressor.ratio.setValueAtTime(12, context.currentTime);
		compressor.attack.setValueAtTime(0, context.currentTime);
		compressor.release.setValueAtTime(0.25, context.currentTime);
		oscillator.connect(compressor);
		compressor.connect(context.destination);
		let settled = false;
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve(value);
		};
		const timer = window.setTimeout(() => finish(), 1200);
		context.oncomplete = (event) => {
			const buffer = event.renderedBuffer.getChannelData(0);
			let sum = 0;
			for (let index = 4500; index < 5000 && index < buffer.length; index += 1) sum += Math.abs(buffer[index]);
			finish(cyrb53(sum.toString()).toString(16));
		};
		oscillator.start(0);
		void context.startRendering().catch(() => finish());
	} catch {
		resolve(undefined);
	}
});

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
	const fingerprint: Record<string, string> = { canvas_cyrb53: cyrb53(canvas.toDataURL()).toString(16) };
	const audio = await audioFingerprint();
	if (audio) fingerprint.audio_cyrb53 = audio;
	return JSON.stringify(fingerprint);
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
		const value = window.localStorage.getItem('device_key')?.trim() ?? '';
		return deviceKeyPattern.test(value) ? value : '';
	} catch {
		return '';
	}
};

const storeDeviceKey = (value: string) => {
	try { window.localStorage.setItem('device_key', value); return true; }
	catch { return false; }
};

/** Generate and persist the per-origin UUID device identifier exactly once. */
const computeDeviceKey = async () => {
	const stored = readStoredDeviceKey();
	if (stored) return stored;
	const key = crypto.randomUUID();
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
