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
	const [regions, nodes, flavors, vms] = await Promise.all([
		count(database, 'pve_regions'),
		count(database, 'pve_nodes'),
		count(database, 'pve_instance_flavors'),
		count(database, 'pve_vms'),
	]);
	const dashboard: DashboardData = {
		recentTitle: 'PVE 资源',
		statistics: [
			{ key: 'regions', label: '地区', value: regions },
			{ key: 'nodes', label: '节点', value: nodes },
			{ key: 'flavors', label: '实例规格', value: flavors },
			{ key: 'vms', label: '虚拟机', value: vms },
		],
		recentColumns: [],
		recentRows: [],
	};
	return apiResponse(c, 200, { dashboard });
};

export default handler;
