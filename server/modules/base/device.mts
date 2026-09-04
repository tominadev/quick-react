import { withDatabaseActors, type DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { readDeviceFingerprint, readDeviceKey, readOptionalDeviceKey, requestDeviceSnapshot } from '@server/modules/base/device-fingerprint.mjs';

/** 为账号建立或恢复当前设备与账号的 Base 绑定。 */
export const ensureBaseDevice = async (rawDatabase: DatabaseAdapter, userId: string | number | bigint, request: Request, resolvedIp?: string, transportIp?: string) => {
	// 设备与绑定关系归属登录中的账号本人。登录流程尚未建立会话，请求级适配器上没有
	// 归属用户，若不在此显式绑定，公共层会把 owner_uid 写成 NULL，这些行日后对本人不可见。
	const database = withDatabaseActors(rawDatabase, { baseUserId: userId });
	const deviceKey = readDeviceKey(request), fingerprint = readDeviceFingerprint(request), now = Date.now(), snapshot = requestDeviceSnapshot(request, resolvedIp, transportIp);
	const deviceData = { ...snapshot, last_seen_at: now, ...(fingerprint ? { fingerprint } : {}) };
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'key', value: deviceKey }] }));
	if (existing?.status === 'revoked') throw new Error('此设备已被注销，无法继续登录');
	if (existing) await runSql(database, sql({ database }).update('base_devices', deviceData, { id: existing.id }));
	else await runSql(database, sql({ database }).insert('base_devices', { user_id: userId, key: deviceKey, fingerprint: fingerprint ?? '{}', ...snapshot, status: 'active', last_seen_at: now }));
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
	const deviceKey = readOptionalDeviceKey(request);
	// 页面导航不能附加 X-Device-Fingerprint；fingerprint 只是分析证据，会话只依赖设备键。
	readDeviceFingerprint(request);
	const documentNavigation = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
	if (!deviceKey && !documentNavigation) return false;
	const binding = await firstSql<{ status: string }>(database, sql({ database }).select({ table: 'base_device_users', columns: { status: 'status' }, where: [{ column: 'device_id', value: deviceId }, { column: 'user_id', value: userId }] }));
	if (!binding || binding.status !== 'active') return false;
	const device = await firstSql<{ key: string; status: string }>(database, sql({ database }).select({ table: 'base_devices', columns: { key: 'key', status: 'status' }, where: [{ column: 'id', value: deviceId }] }));
	return Boolean(device && device.status === 'active' && (!deviceKey || device.key === deviceKey));
};
