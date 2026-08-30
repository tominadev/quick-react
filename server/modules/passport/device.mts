import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { readDeviceFingerprint, requestDeviceSnapshot } from '@server/modules/base/device-fingerprint.mjs';

/** 为 Accounts 账号建立或恢复 Passport 设备与账号的绑定。 */
export const ensurePassportDevice = async (database: DatabaseAdapter, userId: string | number | bigint, request: Request, resolvedIp?: string, transportIp?: string) => {
	const fingerprint = readDeviceFingerprint(request), now = Date.now(), snapshot = requestDeviceSnapshot(request, resolvedIp, transportIp);
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'passport_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (existing?.status === 'revoked') throw new Error('此设备已被注销，无法继续登录');
	if (existing) await runSql(database, sql({ database }).update('passport_devices', { last_seen_at: now, ...snapshot }, { id: existing.id }));
	else await runSql(database, sql({ database }).insert('passport_devices', { fingerprint, ...snapshot, status: 'active', last_seen_at: now }));
	const device = existing ?? await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'passport_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'fingerprint', value: fingerprint }] }));
	if (!device) throw new Error('Passport 设备记录创建失败');
	const deviceId = device.id;
	const binding = await firstSql<{ device_id: string; status: string }>(database, sql({ database }).select({ table: 'passport_device_users', columns: { device_id: { column: 'device_id', cast: 'text' }, status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (binding?.status === 'revoked') throw new Error('该 Accounts 账号已注销此设备，无法使用该设备登录');
	if (binding) await runSql(database, sql({ database }).update('passport_device_users', { status: 'active', revoked_at: null, last_seen_at: now }, { device_id: deviceId, user_id: userId }));
	else await runSql(database, sql({ database }).insert('passport_device_users', { device_id: deviceId, user_id: userId, status: 'active', last_seen_at: now }));
	return deviceId;
};

/** 校验 Accounts 会话绑定的 Passport 设备仍有效且指纹未变化。 */
export const validatePassportDevice = async (database: DatabaseAdapter, userId: string, deviceId: string, request: Request) => {
	const fingerprint = readDeviceFingerprint(request);
	const binding = await firstSql<{ status: string }>(database, sql({ database }).select({ table: 'passport_device_users', columns: { status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (!binding || binding.status !== 'active') return false;
	const device = await firstSql<{ fingerprint: string; status: string }>(database, sql({ database }).select({ table: 'passport_devices', columns: { fingerprint: 'fingerprint', status: 'status' }, where: [{ column: 'id', value: deviceId }] }));
	return Boolean(device && device.status === 'active' && device.fingerprint === fingerprint);
};
