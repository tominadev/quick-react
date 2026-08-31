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
	const [sites, hosts, credentials, bots] = await Promise.all([
		count(database, 'global_sites'),
		count(database, 'global_site_hosts'),
		count(database, 'global_cloud_credentials'),
		count(database, 'global_telegram_bots'),
	]);
	const dashboard: DashboardData = {
		recentTitle: '全局资源',
		statistics: [
			{ key: 'sites', label: '站点', value: sites },
			{ key: 'hosts', label: '域名绑定', value: hosts },
			{ key: 'credentials', label: '云凭据', value: credentials },
			{ key: 'bots', label: 'Telegram 机器人', value: bots },
		],
		recentColumns: [],
		recentRows: [],
	};
	return apiResponse(c, 200, { dashboard });
};

export default handler;
