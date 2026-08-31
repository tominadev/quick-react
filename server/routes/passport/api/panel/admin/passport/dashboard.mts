import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { firstSql, sql } from '@server/database/sql.mjs';
import type { DashboardData } from '@shared/types/dashboard.mjs';

const count = async (database: Parameters<typeof sql>[0]['database'], table: string) => {
	const row = await firstSql<{ count: number | string | bigint }>(database, sql({ database }).count(table));
	return Number(row?.count ?? 0);
};

const handler: ApiHandler = async (c) => {
	const database = c.get('passportDatabase');
	if (!database) return apiMessage(c, 503, 'Accounts 数据库不可用');
	const [users, identities, clients, devices] = await Promise.all([
		count(database, 'passport_users'),
		count(database, 'passport_external_identities'),
		count(database, 'passport_oidc_clients'),
		count(database, 'passport_devices'),
	]);
	const dashboard: DashboardData = {
		recentTitle: 'Accounts 资源',
		statistics: [
			{ key: 'users', label: 'Accounts 用户', value: users },
			{ key: 'identities', label: '外部身份', value: identities },
			{ key: 'clients', label: 'OIDC 客户端', value: clients },
			{ key: 'devices', label: '登录设备', value: devices },
		],
		recentColumns: [],
		recentRows: [],
	};
	return apiResponse(c, 200, { dashboard });
};

export default handler;
