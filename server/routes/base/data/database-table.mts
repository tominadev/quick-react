import type { DatabaseAdapter } from '@server/database/index.mjs';
import { databaseLabel, listColumns, listTables } from '@server/database/schema.mjs';
import { allSql, firstSql, sql, type DeletedScope } from '@server/database/sql.mjs';
import { ROW_KEY_FIELD, type TableActions, type TableColumn, type TableData, type TableResponse, type TableSelectOption } from '@shared/types/table.mjs';
import { isSystemField } from '@shared/system-fields.mjs';

const page = (value: string | undefined, fallback: number) => Math.max(1, Number(value) || fallback);
export const getTables = async (database: DatabaseAdapter) => (await listTables(database)).map((item) => ({ value: item.name, text: item.name }));
export const getColumns = listColumns;
export const databaseOptions = (label: string) => [{ value: 'current', text: label }];
export const databaseQueryFields = (database: DatabaseAdapter, binding: boolean, tables: { value: string; text: string }[]) => [
	{ dataIndex: 'database', label: '数据库', component: 'select' as const, defaultValue: 'current', options: databaseOptions(databaseLabel(database, binding)), reloadSchema: true },
	{ dataIndex: 'table', label: '数据表', component: 'select' as const, placeholder: '选择数据表', options: tables, defaultValue: tables[0]?.value, reloadSchema: true },
];
export const databaseTableActions = (editable: boolean, options: { softDelete?: boolean } = {}): TableActions => {
	const softDelete = options.softDelete ?? true;
	const deleteConfirm = softDelete ? '删除后可在回收站找回或彻底删除，确定继续吗？' : '删除字段后无法恢复，确定继续吗？';
	return {
		toolbar: editable ? [
			{ key: 'create', label: '新增' },
			{ key: 'delete', label: '删除', confirm: deleteConfirm },
		] : [],
		query: [{ key: 'search', label: '搜索' }],
		row: editable ? [
			{ key: 'edit', label: '编辑' },
			{ key: 'delete', label: '删除', confirm: deleteConfirm },
		] : [],
	};
};
export type DatabaseTableResponse = TableResponse & { tables: TableSelectOption[]; editable: boolean };
const tableColumn = (column: Awaited<ReturnType<typeof getColumns>>[number]): TableColumn => ({
	dataIndex: column.name,
	title: column.name,
	component: 'textbox',
	dataType: /INT/i.test(column.type) ? 'int' : /REAL|FLOA|DOUB|DECIMAL|NUMERIC/i.test(column.type) ? 'float' : 'string',
	// key 新建时可以填（人给短串的表要填），建好之后不可改：它是别的表的引用目标。
	...(column.name === 'key' ? { form: { edit: false as const } } : isSystemField(column.name) ? { form: { create: false as const, edit: false as const } } : {}),
});
export const databaseSelectColumns = (columns: Awaited<ReturnType<typeof getColumns>>) => Object.fromEntries(columns.map((column) => [column.name, /INT/i.test(column.type) ? { column: column.name, cast: 'text' as const } : column.name]));
export const readTable = async (database: DatabaseAdapter, mode: 'columns' | 'rows', tableName: string | undefined, pageNumValue?: string, pageSizeValue?: string, options: { deleted?: DeletedScope; tables?: TableSelectOption[] } = {}): Promise<DatabaseTableResponse> => {
	const tables = options.tables ?? await getTables(database);
	const selectedTableName = tableName || tables[0]?.value;
	if (!selectedTableName || !tables.some((item) => item.value === selectedTableName)) return { tables, editable: false, dataSource: [], totalRecords: 0, option: { rowKey: ROW_KEY_FIELD } };
	const info = await getColumns(database, selectedTableName);
	if (mode === 'columns') {
		// 字段名本身就是这一行的主键，不必再合成一个。
		const rows = info.map((column) => ({ name: column.name, type: column.type || '—', notnull: Boolean(column.notnull), pk: Boolean(column.pk) }));
		return { tables, editable: true, columns: [{ dataIndex: 'name', title: '字段名', component: 'textbox' }, { dataIndex: 'type', title: '类型', component: 'textbox' }, { dataIndex: 'notnull', title: '必填', component: 'switch' }, { dataIndex: 'pk', title: '主键', component: 'switch' }], dataSource: rows, totalRecords: rows.length, option: { rowKey: 'name' } };
	}
	const primaryKey = info.find((column) => column.pk)?.name;
	const sqliteRowId = !primaryKey && (database.dialect ?? 'sqlite') === 'sqlite';
	const rowKey = primaryKey ?? (sqliteRowId ? '__rowid__' : '');
	const pageNum = page(pageNumValue, 1), pageSize = page(pageSizeValue, 10);
	const deleted = options.deleted ?? database.deletedScope ?? 'active';
	const total = await firstSql<{ count: number | string }>(database, sql({ database }).count(selectedTableName, [], deleted));
	// Database administration pages must preserve 64-bit IDs. Casting integer
	// columns to text prevents SQLite from coercing snowflake IDs to unsafe JS numbers.
	const selectedColumns = databaseSelectColumns(info);
	const rows = await allSql<TableData>(database, sql({ database }).select({ table: selectedTableName, columns: selectedColumns, sqliteRowIdAlias: sqliteRowId ? '__rowid__' : undefined, limit: pageSize, offset: (pageNum - 1) * pageSize, deleted }));
	// 有主键就直接用那一列当 rowKey，不再往行里塞字段——塞进去会覆盖这张表自己的同名列，
	// `base_configs.key` 就是这么在列表上变成数字的。没有主键的表才合成一个保留字段。
	const dataSource = rowKey ? rows : rows.map((row, index) => ({ ...row, [ROW_KEY_FIELD]: `readonly-${(pageNum - 1) * pageSize + index + 1}` }));
	const dataColumns = info.map(tableColumn);
	const idIndex = dataColumns.findIndex((column) => column.dataIndex === 'id');
	if (idIndex > 0) dataColumns.unshift(dataColumns.splice(idIndex, 1)[0]);
	if (sqliteRowId) dataColumns.unshift({ dataIndex: '__rowid__', title: 'ID', dataType: 'int' });
	return { tables, editable: Boolean(rowKey), columns: dataColumns, dataSource, totalRecords: Number(total?.count ?? 0), option: { rowKey: rowKey || ROW_KEY_FIELD } };
};
export const assertTable = async (database: DatabaseAdapter, tableName: string) => { if (!(await getTables(database)).some((item) => item.value === tableName)) throw new Error('数据表不存在'); };
export const tableRowKey = (database: DatabaseAdapter, columns: Awaited<ReturnType<typeof getColumns>>) => {
	const primaryKey = columns.find((column) => column.pk)?.name;
	if (primaryKey) return primaryKey;
	if ((database.dialect ?? 'sqlite') === 'sqlite') return 'rowid';
	throw new Error('该表没有主键，在 MySQL/PostgreSQL 中只能查看，不能编辑或删除');
};
