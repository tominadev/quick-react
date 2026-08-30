let fingerprintPromise: Promise<string> | undefined;
let networkInfoPromise: Promise<string> | undefined;

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
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canvas.toDataURL()));
	const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	document.cookie = `passport_device_fingerprint=${fingerprint}; Path=/; SameSite=Lax`;
	return fingerprint;
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
