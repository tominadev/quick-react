import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 设备指纹只接受客户端生成的 SHA-256（小写十六进制）结果。
 * 设备属于 Base 能力，身份中心和业务站点都通过这里读写设备审计来源。
 */
export const readDeviceFingerprint = (request: Request) => {
	const header = request.headers.get('x-device-fingerprint')?.trim() ?? '';
	const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('passport_device_fingerprint='))?.slice('passport_device_fingerprint='.length) ?? '';
	const value = header || cookie;
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('设备指纹无效，请刷新页面后重试');
	return value;
};

const requestDeviceSnapshot = (request: Request) => ({
	user_agent: request.headers.get('user-agent') ?? '',
	platform: request.headers.get('sec-ch-ua-platform') ?? '',
	ip_address: request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '',
});

/** 为账号建立或恢复当前设备与账号的 Base 绑定。 */
export const ensureBaseDevice = async (database: DatabaseAdapter, userId: string, request: Request) => {
	const fingerprint = readDeviceFingerprint(request), now = Date.now(), snapshot = requestDeviceSnapshot(request);
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (existing) await runSql(database, sql({ database }).update('base_devices', { last_seen_at: now, ...snapshot }, { id: existing.id }));
	else await runSql(database, sql({ database }).insert('base_devices', { user_id: userId, fingerprint, ...snapshot, status: 'active', last_seen_at: now }));
	const device = existing ?? await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (!device) throw new Error('设备记录创建失败');
	const deviceId = device.id;
	const binding = await firstSql<{ device_id: string; status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { device_id: { column: 'device_id', cast: 'text' }, status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (binding) await runSql(database, sql({ database }).update('base_device_users', { status: 'active', revoked_at: null, last_seen_at: now }, { device_id: deviceId, user_id: userId }));
	else await runSql(database, sql({ database }).insert('base_device_users', { device_id: deviceId, user_id: userId, status: 'active', last_seen_at: now }));
	return deviceId;
};

/** 校验会话绑定的设备仍属于当前账号且指纹没有变化。 */
export const validateBaseDevice = async (database: DatabaseAdapter, userId: string, deviceId: string, request: Request) => {
	const fingerprint = readDeviceFingerprint(request);
	const binding = await firstSql<{ status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (!binding || binding.status !== 'active') return false;
	const device = await firstSql<{ fingerprint: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { fingerprint: 'fingerprint', status: 'status' }, where: [{ column: 'id', value: deviceId }] }));
	return Boolean(device && device.status === 'active' && device.fingerprint === fingerprint);
};
