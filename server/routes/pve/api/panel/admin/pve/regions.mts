import { pveCrud } from '@server/modules/pve/admin-crud.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
export const acceptsTrailingParams = true;
export default pveCrud({ table: 'pve_regions', key: 'id', columns: [{ dataIndex: 'id', title: 'ID', dataType: 'int' }, { dataIndex: 'key', title: '代码', component: 'textbox' }, { dataIndex: 'title', title: '名称', component: 'textbox' }, { dataIndex: 'status', title: '状态', component: 'switch', checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions }], writable: ['key', 'title', 'status', 'sort_order'] });
