import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { validateBaseDevice } from '@server/modules/base/device.mjs';
import { parseRoles } from '@shared/types/role.mjs';

const encoder = new TextEncoder();
const iterations = 210_000;

const toBase64 = (value: Uint8Array) => {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
};

const fromBase64 = (value: string) => {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const derivePassword = async (password: string, salt: Uint8Array, count: number) => {
	const passwordBytes = encoder.encode(password);
	const material = await crypto.subtle.importKey('raw', passwordBytes.buffer as ArrayBuffer, 'PBKDF2', false, ['deriveBits']);
	const saltBuffer = Uint8Array.from(salt).buffer;
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations: count }, material, 256));
};

export const hashPassword = async (password: string) => {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derivePassword(password, salt, iterations);
	return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
};

export type StoredPassword = {
	hash: string;
	pattern: string;
};

export const createStoredPassword = async (password: string) => {
	let pattern = '';
	for (const character of password) {
		if (/^[0-9]$/.test(character)) pattern += 'D';
		else if (/^[A-Z]$/.test(character)) pattern += 'U';
		else if (/^[a-z]$/.test(character)) pattern += 'L';
		else pattern += 'S';
	}
	return JSON.stringify({
		hash: await hashPassword(password),
		pattern,
	} satisfies StoredPassword);
};

export const readStoredPassword = (value: unknown): StoredPassword | undefined => {
	if (typeof value !== 'string') return undefined;
	try {
		const parsed = JSON.parse(value) as Partial<StoredPassword>;
		const pattern = parsed.pattern;
		if (
			typeof parsed.hash !== 'string'
			|| typeof pattern !== 'string' || !/^[DULS]*$/.test(pattern)
		) return undefined;
		return { hash: parsed.hash, pattern };
	} catch {
		return undefined;
	}
};

export const verifyStoredPassword = async (password: string, value: unknown) => {
	const stored = readStoredPassword(value);
	return stored ? verifyPassword(password, stored.hash) : false;
};

export const verifyPassword = async (password: string, encoded: string) => {
	const [algorithm, countText, saltText, hashText] = encoded.split('$');
	const count = Number(countText);
	if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(count) || count < 100_000 || !saltText || !hashText) return false;
	const expected = fromBase64(hashText);
	const actual = await derivePassword(password, fromBase64(saltText), count);
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
	return difference === 0;
};

export const sessionCookieName = 'base_session';
/** Base 会话采用滑动过期：连续 7 天没有有效请求才失效。 */
export const baseSessionMaxAge = 7 * 24 * 60 * 60;

/** 会话 Cookie 只保存随机原令牌，数据库只保存不可逆摘要。 */
export const hashSessionToken = async (token: string) => {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

export const readSessionId = (request: Request) => {
	const cookies = request.headers.get('cookie') ?? '';
	for (const part of cookies.split(';')) {
		const [name, ...value] = part.trim().split('=');
		if (name === sessionCookieName) return decodeURIComponent(value.join('='));
	}
	return undefined;
};

export const createSessionCookie = (sessionId: string, secure: boolean, maxAge: number) =>
	`${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

export const clearSessionCookie = (secure: boolean) =>
	`${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

export const loadCurrentUser = async (database: DatabaseAdapter, request: Request) => {
	const sessionId = readSessionId(request);
	if (!sessionId) return undefined;
	const sessionHash = await hashSessionToken(sessionId);
	const row = await firstSql<{ id: number; username: string; roles: string; tenant_id: string | null; device_id: string | null }>(database, sql({ database }).select({ table: 'base_sessions', alias: 's', columns: { id: 'u.id', username: 'u.name', roles: 'u.roles', tenant_id: { column: 'u.owner_tid', cast: 'text' }, device_id: { column: 's.device_id', cast: 'text' } }, joins: [{ table: 'base_users', alias: 'u', left: 'u.id', right: 's.user_id' }], where: [{ column: 's.token_hash', value: sessionHash }, { column: 's.expires_at', operator: '>', value: Date.now() }, { column: 'u.status', value: 'enabled' }] }));
	if (!row) return undefined;
	if (!row.device_id) {
		await runSql(database, sql({ database }).delete('base_sessions', { token_hash: sessionHash }));
		return undefined;
	}
	try {
		if (await validateBaseDevice(database, String(row.id), row.device_id, request)) {
			await runSql(database, sql({ database }).update('base_sessions', { expires_at: Date.now() + baseSessionMaxAge * 1000 }, { token_hash: sessionHash }));
			return { id: row.id, username: row.username, roles: parseRoles(row.roles), tenantId: row.tenant_id };
		}
	} catch {
		// 指纹格式错误同样使当前会话失效。
	}
	await runSql(database, sql({ database }).delete('base_sessions', { token_hash: sessionHash }));
	return undefined;
};

/** Resolve the Base device-user binding that owns the current session. */
export const loadBaseDeviceUserId = async (database: DatabaseAdapter, request: Request): Promise<string | number | bigint | null> => {
	const sessionId = readSessionId(request);
	if (!sessionId) return null;
	const sessionHash = await hashSessionToken(sessionId);
	const session = await firstSql<{ user_id: string; device_id: string | null }>(database, sql({ database }).select({
		table: 'base_sessions',
		columns: { user_id: { column: 'user_id', cast: 'text' }, device_id: { column: 'device_id', cast: 'text' } },
		where: [{ column: 'token_hash', value: sessionHash }, { column: 'expires_at', operator: '>', value: Date.now() }],
		limit: 1,
	}));
	if (!session?.device_id) return null;
	const binding = await firstSql<{ id: string }>(database, sql({ database }).select({
		table: 'base_device_users',
		columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'device_id', value: session.device_id }, { column: 'user_id', value: session.user_id }, { column: 'status', value: 'active' }],
		limit: 1,
	}));
	return binding?.id ?? null;
};

/** 当前本站会话是否由 Accounts OIDC 登录创建。 */
export const sessionUsesAccountsOidc = async (database: DatabaseAdapter, request: Request) => {
	const sessionId = readSessionId(request);
	if (!sessionId) return false;
	const session = await firstSql<{ id: number | string | bigint }>(database, sql({ database }).select({ table: 'base_sessions', columns: { id: 'id' }, where: [{ column: 'token_hash', value: await hashSessionToken(sessionId) }], limit: 1 }));
	return Boolean(session && await firstSql(database, sql({ database }).select({ table: 'base_oidc_sessions', columns: { session_id: 'session_id' }, where: [{ column: 'session_id', value: String(session.id) }], limit: 1 })));
};
