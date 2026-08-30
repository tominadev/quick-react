import { pveCrud } from '@server/modules/pve/admin-crud.mjs';
import { allSql, sql } from '@server/database/sql.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
export const acceptsTrailingParams = true;

const columns = [{ dataIndex: 'id', title: 'ID', dataType: 'int' }, { dataIndex: 'region_id', title: '地区', component: 'select', rules: [{ required: true, message: '请选择地区' }] }, { dataIndex: 'name', title: '节点', component: 'textbox', rules: [{ required: true, message: '请输入节点名称' }] }, { dataIndex: 'host', title: 'Host', component: 'textbox', rules: [{ required: true, message: '请输入 Host' }] }, { dataIndex: 'port', title: '端口', component: 'textbox', dataType: 'int' }, { dataIndex: 'api_user', title: 'API 用户', component: 'textbox', rules: [{ required: true, message: '请输入 API 用户' }] }, { dataIndex: 'api_token_id', title: 'Token ID', component: 'textbox', rules: [{ required: true, message: '请输入 Token ID' }] }, { dataIndex: 'api_token_secret', title: 'Token Secret', component: 'textbox', inputType: 'password', rules: [{ required: true, message: '请输入 Token Secret' }] }, { dataIndex: 'status', title: '状态', component: 'switch', checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions }];

export default pveCrud({ table: 'pve_nodes', key: 'id', columns, writable: ['region_id', 'name', 'host', 'port', 'cluster_name', 'api_user', 'api_token_id', 'api_token_secret', 'status'], prepareColumns: async (database) => {
	const regions = (await allSql<{ id: number; code: string; display_name: string; status: unknown }>(database, sql({ database }).select({ table: 'pve_regions', columns: { id: 'id', code: 'code', display_name: 'display_name', status: 'status' }, orderBy: [{ column: 'sort_order' }, { column: 'id' }] })))
		.filter((region) => region.status === 'enabled' || region.status === 1 || region.status === true || ['1', '1.0', 'true'].includes(String(region.status).toLowerCase()));
	return columns.map((column) => column.dataIndex === 'region_id' ? { ...column, options: regions.map((region) => ({ value: String(region.id), text: `${region.display_name} (id:${region.id}, code:${region.code})` })) } : column);
} });
