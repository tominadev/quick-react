import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { validateBaseDevice } from '@server/modules/base/device.mjs';
import { profileNicknameOf } from '@server/modules/base/profile.mjs';
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

/**
 * 口令摘要的各个参数分开存，不再挤进一个 `$` 分隔的字符串。
 *
 * `password` 本来就是 JSON 列，把算法、迭代次数、盐和摘要拼成一行字符串只是徒增一层
 * 自定义编码：解析要自己 split、校验要自己数段数，出错了还得肉眼数 `$`。分开之后
 * 每个参数各占一个字段，读写都是普通的对象访问，审计里看到的也是四个具名值。
 *
 * 算法一并存进去而不是写死在代码里：将来换算法时，旧记录带着自己的参数，还能照常校验。
 */
export type PasswordDigest = {
	algorithm: 'pbkdf2-sha256';
	iterations: number;
	/** base64，16 字节随机盐。 */
	salt: string;
	/** base64，256 位派生摘要。 */
	hash: string;
};

const minimumIterations = 100_000;

export const createPasswordDigest = async (password: string): Promise<PasswordDigest> => {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return { algorithm: 'pbkdf2-sha256', iterations, salt: toBase64(salt), hash: toBase64(await derivePassword(password, salt, iterations)) };
};

export const readPasswordDigest = (value: unknown): PasswordDigest | undefined => {
	if (!value || typeof value !== 'object') return undefined;
	const { algorithm, iterations: count, salt, hash } = value as Partial<PasswordDigest>;
	// 迭代次数下限在这里挡住：读到一条被人手工改小的记录时，宁可校验失败也不要用它。
	if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(count) || (count as number) < minimumIterations) return undefined;
	if (typeof salt !== 'string' || !salt || typeof hash !== 'string' || !hash) return undefined;
	return { algorithm, iterations: count as number, salt, hash };
};

export const verifyPasswordDigest = async (password: string, digest: PasswordDigest) => {
	const expected = fromBase64(digest.hash);
	const actual = await derivePassword(password, fromBase64(digest.salt), digest.iterations);
	if (actual.length !== expected.length) return false;
	// 逐字节异或后再判断，比较耗时与匹配前缀长度无关。
	let difference = 0;
	for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
	return difference === 0;
};

/**
 * 一次性验证码的摘要存在 TEXT 列（`*.code_hash`）里，只能是一个字符串，
 * 因此保留 `算法$迭代次数$盐$摘要` 这种拼接编码。验证码不是密码，不共用存储形态。
 */
export const hashPassword = async (password: string) => {
	const digest = await createPasswordDigest(password);
	return `${digest.algorithm}$${digest.iterations}$${digest.salt}$${digest.hash}`;
};

export const verifyPassword = async (password: string, encoded: string) => {
	const [algorithm, countText, salt, hash] = encoded.split('$');
	const digest = readPasswordDigest({ algorithm, iterations: Number(countText), salt, hash });
	return digest ? verifyPasswordDigest(password, digest) : false;
};

/** 存进 `password` JSON 列的完整内容：摘要参数 + 密码字符类布局。 */
export type StoredPassword = PasswordDigest & {
	/** 每个字符按 D(数字)/U(大写)/L(小写)/S(其他) 归类，用户管理页显示密码规律。 */
	pattern: string;
};

export const createStoredPassword = async (password: string): Promise<StoredPassword> => {
	let pattern = '';
	for (const character of password) {
		if (/^[0-9]$/.test(character)) pattern += 'D';
		else if (/^[A-Z]$/.test(character)) pattern += 'U';
		else if (/^[a-z]$/.test(character)) pattern += 'L';
		else pattern += 'S';
	}
	// 返回对象而不是 JSON 文本：password 是 JSON 列，序列化交给数据库适配器统一做。
	return { ...await createPasswordDigest(password), pattern };
};

export const readStoredPassword = (value: unknown): StoredPassword | undefined => {
	// 四种方言读 JSON 列都归一成文本（见 postgresql.mts 的 setTypeParser），
	// 但同一个对象刚写进去、还没落库回读时也可能直接传进来，两种都接。
	if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return undefined;
	try {
		const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<StoredPassword>;
		const digest = readPasswordDigest(parsed);
		if (!digest || typeof parsed.pattern !== 'string' || !/^[DULS]*$/.test(parsed.pattern)) return undefined;
		return { ...digest, pattern: parsed.pattern };
	} catch {
		return undefined;
	}
};

export const verifyStoredPassword = async (password: string, value: unknown) => {
	const stored = readStoredPassword(value);
	return stored ? verifyPasswordDigest(password, stored) : false;
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
	const row = await firstSql<{ id: number; user_name: string; profile_nickname: string | null; roles: string; tenant_id: string | null; device_id: string | null }>(database, sql({ database }).select({ table: 'base_sessions', alias: 's', columns: { id: 'u.id', user_name: 'u.name', profile_nickname: 'p.nickname', roles: 'u.roles', tenant_id: { column: 'u.owner_tid', cast: 'text' }, device_id: { column: 's.device_id', cast: 'text' } }, joins: [{ table: 'base_users', alias: 'u', left: 'u.id', right: 's.user_id' }, { type: 'LEFT' as const, table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 's.user_id' }], where: [{ column: 's.token_hash', value: sessionHash }, { column: 's.expires_at', operator: '>', value: Date.now() }, { column: 'u.status', value: 'enabled' }] }));
	if (!row) return undefined;
	if (!row.device_id) {
		await runSql(database, sql({ database }).delete('base_sessions', { token_hash: sessionHash }));
		return undefined;
	}
	try {
		if (await validateBaseDevice(database, String(row.id), row.device_id, request)) {
			await runSql(database, sql({ database }).update('base_sessions', { expires_at: Date.now() + baseSessionMaxAge * 1000 }, { token_hash: sessionHash }));
			return { id: row.id, user_name: row.user_name, profile_nickname: profileNicknameOf(row.user_name, row.profile_nickname), roles: parseRoles(row.roles), tenantId: row.tenant_id };
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
