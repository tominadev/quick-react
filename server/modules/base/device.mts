import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { readDeviceFingerprint, readDeviceKey, requestDeviceSnapshot } from '@server/modules/base/device-fingerprint.mjs';

/** 为账号建立或恢复当前设备与账号的 Base 绑定。 */
export const ensureBaseDevice = async (database: DatabaseAdapter, userId: string | number | bigint, request: Request, resolvedIp?: string, transportIp?: string) => {
	const deviceKey = readDeviceKey(request), fingerprint = readDeviceFingerprint(request), now = Date.now(), snapshot = requestDeviceSnapshot(request, resolvedIp, transportIp);
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'key', value: deviceKey }] }));
	if (existing?.status === 'revoked') throw new Error('此设备已被注销，无法继续登录');
	if (existing) await runSql(database, sql({ database }).update('base_devices', { fingerprint, last_seen_at: now, ...snapshot }, { id: existing.id }));
	else await runSql(database, sql({ database }).insert('base_devices', { user_id: userId, key: deviceKey, fingerprint, ...snapshot, status: 'active', last_seen_at: now }));
	const device = existing ?? await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'key', value: deviceKey }] }));
	if (!device) throw new Error('设备记录创建失败');
	const deviceId = device.id;
	const binding = await firstSql<{ device_id: string; status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { device_id: { column: 'device_id', cast: 'text' }, status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (binding?.status === 'revoked') throw new Error('该账号已注销此设备，无法使用该设备登录');
	if (binding) await runSql(database, sql({ database }).update('base_device_users', { status: 'active', revoked_at: null, last_seen_at: now }, { device_id: deviceId, user_id: userId }));
	else await runSql(database, sql({ database }).insert('base_device_users', { device_id: deviceId, user_id: userId, status: 'active', last_seen_at: now }));
	return deviceId;
};

/** 校验会话绑定的设备仍属于当前账号且客户端设备唯一键没有变化。 */
export const validateBaseDevice = async (database: DatabaseAdapter, userId: string, deviceId: string, request: Request) => {
	const deviceKey = readDeviceKey(request);
	readDeviceFingerprint(request);
	const binding = await firstSql<{ status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (!binding || binding.status !== 'active') return false;
	const device = await firstSql<{ key: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { key: 'key', status: 'status' }, where: [{ column: 'id', value: deviceId }] }));
	return Boolean(device && device.status === 'active' && device.key === deviceKey);
};
