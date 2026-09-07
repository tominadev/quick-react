import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, sql } from '@server/database/sql.mjs';

/**
 * 平台推送密钥：生成、取当前签名密钥、取要公布的公钥。
 *
 * Ed25519 的 WebCrypto 在 Node 与 Cloudflare Workers 上都可用，两端走同一段代码
 * （绑定文档 §10 要求先用同一测试向量跑通；Node 侧已验：生成、导出 raw/pkcs8、
 * 导回后签名一致、篡改后验签失败）。
 */

const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64Url = (bytes: ArrayBuffer) => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromBase64 = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));

/** `kid` 由公钥算出：换了公钥它自动跟着变，也就不存在「kid 与公钥对不上」这种配错。 */
export const platformKeyId = async (publicKey: string) => {
	const digest = await crypto.subtle.digest('SHA-256', fromBase64(publicKey));
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

export const generatePlatformKey = async () => {
	const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
	const publicKey = base64Url(await crypto.subtle.exportKey('raw', pair.publicKey));
	return {
		publicKey,
		// PKCS#8 的 Base64（不是 URL 变体）：导回时 importKey 直接吃这个格式。
		privateKey: base64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
		kid: await platformKeyId(publicKey),
	};
};

type PlatformKeyRow = { id: string; kid: string; public_key: string; private_key?: string; status: string };

/**
 * 当前用来签名的那把。
 *
 * 取 `active` 里**最新的一条**：轮换时先插新的、再把旧的转 retiring，中间会有一瞬间两把
 * 都是 active（无事务环境下这是刻意选的顺序——反过来会有一瞬间一把都没有，那时候的投递
 * 直接签不了名）。取最新那把，中间态因此不影响任何一次投递。
 */
export const loadSigningKey = async (database: DatabaseAdapter) => (await allSql<PlatformKeyRow>(database, sql({ database, subjectRoles: null }).select({
	table: 'sms_platform_keys',
	columns: { id: { column: 'id', cast: 'text' }, kid: 'kid', public_key: 'public_key', private_key: 'private_key', status: 'status' },
	where: [{ column: 'status', value: 'active' }],
	orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
})))[0];

/** 要公布给接收方的公钥：当前签名那把，加上还在退役观察期里的。 */
export const loadPublishedKeys = async (database: DatabaseAdapter) => allSql<PlatformKeyRow>(database, sql({ database, subjectRoles: null }).select({
	table: 'sms_platform_keys',
	columns: { id: { column: 'id', cast: 'text' }, kid: 'kid', public_key: 'public_key', status: 'status' },
	// 「不是 retired」就是要公布的那两种。写成 status != 'retired' 而不是列举，
	// 将来多一种过渡状态时这里不用跟着改——而漏改的表现是那把公钥突然不再公布。
	where: [{ column: 'status', operator: '!=', value: 'retired' }],
	orderBy: [{ column: 'id', direction: 'DESC' }],
}));

/** 用私钥签一段字节。输入是 `timestamp + "." + 原始请求体`（§4.9.2）。 */
export const signWithPlatformKey = async (privateKeyBase64: string, payload: string) => {
	const key = await crypto.subtle.importKey('pkcs8', fromBase64(privateKeyBase64), { name: 'Ed25519' }, false, ['sign']);
	return base64Url(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload)));
};
