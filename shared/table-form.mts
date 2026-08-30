import type { TableColumn } from './types/table.mjs';
import { isSystemField } from './system-fields.mjs';

export type TableFormMode = 'create' | 'edit';

export const resolveTableFormColumns = (columns: TableColumn[], mode: TableFormMode): TableColumn[] => columns.flatMap((definition) => {
	if (isSystemField(definition.dataIndex)) return [];
	const { form, ...column } = definition;
	const override = form?.[mode];
	if (override === false) return [];
	return [{ ...column, ...override }];
});
