import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiResponse } from '@server/modules/base/api-response.mjs';
import { firstSql, sql } from '@server/database/sql.mjs';
import type { DashboardData } from '@shared/types/dashboard.mjs';

const count = async (database: Parameters<typeof sql>[0]['database'], table: string) => {
	const row = await firstSql<{ count: number | string | bigint }>(database, sql({ database }).count(table));
	return Number(row?.count ?? 0);
};

const handler: ApiHandler = async (c) => {
	const database = c.get('database');
	const [users, sessions, devices, configs] = await Promise.all([
		count(database, 'base_users'),
		count(database, 'base_sessions'),
		count(database, 'base_devices'),
		count(database, 'base_configs'),
	]);
	const dashboard: DashboardData = {
		recentTitle: '基础资源',
		statistics: [
			{ key: 'users', label: '系统用户', value: users },
			{ key: 'sessions', label: '会话', value: sessions },
			{ key: 'devices', label: '设备', value: devices },
			{ key: 'configs', label: '配置项', value: configs },
		],
		recentColumns: [],
		recentRows: [],
	};
	return apiResponse(c, 200, { dashboard });
};

export default handler;
