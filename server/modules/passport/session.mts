import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

export const passportSessionCookieName = 'passport_session';

const readCookie = (request: Request, name: string) => {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [candidate, ...value] = part.trim().split('=');
		if (candidate === name) return decodeURIComponent(value.join('='));
	}
};

export const readPassportSessionId = (request: Request) => readCookie(request, passportSessionCookieName);
export const createPassportSessionCookie = (sessionId: string, secure: boolean, maxAge: number) =>
	`${passportSessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export const clearPassportSessionCookie = (secure: boolean) =>
	`${passportSessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

export const readDeviceFingerprint = (request: Request) => {
	const header = request.headers.get('x-device-fingerprint')?.trim() ?? '';
	const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('passport_device_fingerprint='))?.slice('passport_device_fingerprint='.length) ?? '';
	const value = header || cookie;
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('设备指纹无效，请刷新页面后重试');
	return value;
};

export const ensurePassportDevice = async (database: DatabaseAdapter, userId: string, request: Request) => {
	const fingerprint = readDeviceFingerprint(request), now = Date.now();
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (existing) {
		await runSql(database, sql({ database }).update('base_devices', { last_seen_at: now, user_agent: request.headers.get('user-agent') ?? '', platform: request.headers.get('sec-ch-ua-platform') ?? '', ip_address: request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '' }, { id: existing.id }));
	} else {
		await runSql(database, sql({ database }).insert('base_devices', { user_id: userId, fingerprint, user_agent: request.headers.get('user-agent') ?? '', platform: request.headers.get('sec-ch-ua-platform') ?? '', ip_address: request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '', status: 'active', last_seen_at: now }));
	}
	const device = existing ?? await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (!device) throw new Error('设备记录创建失败');
	const deviceId = device.id;
	const binding = await firstSql<{ device_id: string; status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { device_id: { column: 'device_id', cast: 'text' }, status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (binding) await runSql(database, sql({ database }).update('base_device_users', { status: 'active', revoked_at: null, last_seen_at: now }, { device_id: deviceId, user_id: userId }));
	else await runSql(database, sql({ database }).insert('base_device_users', { device_id: deviceId, user_id: userId, status: 'active', last_seen_at: now }));
	return deviceId;
};

/**
 * 读取身份中心自身的会话；业务站点通过 OIDC 建立本站会话，不共享这个 Cookie。
 * Accounts 只提供身份，不带任何权限：站点角色一律由站点自己在用户管理里分配。
 */
export const loadPassportSession = async (database: DatabaseAdapter, request: Request) => {
	const sessionId = readPassportSessionId(request);
	if (!sessionId) return undefined;
	const user = await firstSql<{ user_id: string; nickname: string; device_id?: string | null }>(database, sql({ database }).select({ table: 'passport_sessions', alias: 's', columns: { user_id: { column: 'u.user_id', cast: 'text' }, nickname: 'u.nickname', device_id: { column: 's.device_id', cast: 'text' } }, joins: [{ table: 'passport_users', alias: 'u', left: 'u.user_id', right: 's.user_id' }], where: [{ column: 's.id', value: sessionId }, { column: 's.expires_at', operator: '>', value: Date.now() }, { column: 'u.status', value: 'enabled' }] }));
	if (!user) return undefined;
	if (!user.device_id) {
		await runSql(database, sql({ database }).delete('passport_sessions', { id: sessionId }));
		return undefined;
	}
	let fingerprint: string;
	try { fingerprint = readDeviceFingerprint(request); } catch {
		await runSql(database, sql({ database }).delete('passport_sessions', { id: sessionId }));
		return undefined;
	}
	const binding = await firstSql<{ status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { status: 'status' }, where: [{ column: 'device_id', value: user.device_id }, { column: 'user_id', value: user.user_id }] }));
	if (!binding || binding.status !== 'active') {
		await runSql(database, sql({ database }).delete('passport_sessions', { id: sessionId }));
		return undefined;
	}
	const device = await firstSql<{ fingerprint: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { fingerprint: 'fingerprint', status: 'status' }, where: [{ column: 'id', value: user.device_id }] }));
	if (!device || device.status !== 'active' || device.fingerprint !== fingerprint) {
		await runSql(database, sql({ database }).delete('passport_sessions', { id: sessionId }));
		return undefined;
	}
	return { id: user.user_id, username: user.nickname, roles: [] };
};
