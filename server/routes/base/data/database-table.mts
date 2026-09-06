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
/**
 * 界面上的限制**一律照抄表结构**，不自己加也不自己减。
 *
 * - **能不能存 NULL** 看 `notnull`：可空的列才给那个「未填写」控件。不额外标成必填——
 *   `NOT NULL` 说的是「不能是 NULL」，不是「不能是空串」，标了必填就是替表加了一条它
 *   没有的限制。
 * - **多长** 看 `VARCHAR(n)`；`TEXT` 这类没有上限的列不给 maxLength——表没规定，界面就
 *   不该替它规定。
 * - **数值型给数字输入框**，但 **BIGINT 除外**：雪花号有 19 位，超过 JS 能精确表示的整数，
 *   进了数字输入框会被悄悄改成另一个数。这一页读 INT 列时本来就一路 cast 成文本
 *   （见 databaseSelectColumns），正是同一个原因。
 */
const numericComponent = (type: string) => /BIGINT|INT8/i.test(type) ? undefined
	: /INT|REAL|FLOA|DOUB|DECIMAL|NUMERIC/i.test(type) ? 'inputnumber' as const : undefined;

const tableColumn = (column: Awaited<ReturnType<typeof getColumns>>[number]): TableColumn => ({
	dataIndex: column.name,
	title: column.name,
	component: numericComponent(column.type) ?? 'textbox',
	dataType: /INT/i.test(column.type) ? 'int' : /REAL|FLOA|DOUB|DECIMAL|NUMERIC/i.test(column.type) ? 'float' : 'string',
	...(column.maxLength ? { maxLength: column.maxLength } : {}),
	// 表自己说了能不能存 NULL，这一页照搬——它看的就是表长什么样。
	...(column.notnull ? {} : { nullable: true }),
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
	// 数据管理**不过滤 queued_at**：它看的是表里实际有什么，不是「批准了什么」。
	//
	// 过滤掉的话，待审批的新行在这里凭空消失：审批卡住时查不到那一行、算不清行数，
	// 想直接清掉一条卡死的申请也无从下手——而这一页本就是平台管理员绕过业务语义
	// 直接看原始表的地方，唯一的用处就是「看见真实状态」。列表里 queued_at 那一列
	// 摆在那儿，是 0 还是时间戳一眼可辨，不会认错。
	const total = await firstSql<{ count: number | string }>(database, sql({ database }).count(selectedTableName, [], deleted, 'all'));
	// Database administration pages must preserve 64-bit IDs. Casting integer
	// columns to text prevents SQLite from coercing snowflake IDs to unsafe JS numbers.
	const selectedColumns = databaseSelectColumns(info);
	const rows = await allSql<TableData>(database, sql({ database }).select({ table: selectedTableName, columns: selectedColumns, sqliteRowIdAlias: sqliteRowId ? '__rowid__' : undefined, limit: pageSize, offset: (pageNum - 1) * pageSize, deleted, queued: 'all' }));
	// 有主键就直接用那一列当 rowKey，不再往行里塞字段——塞进去会覆盖这张表自己的同名列，
	// `base_configs.key` 就是这么在列表上变成数字的。没有主键的表才合成一个保留字段。
	const dataSource = rowKey ? rows : rows.map((row, index) => ({ ...row, [ROW_KEY_FIELD]: `readonly-${(pageNum - 1) * pageSize + index + 1}` }));
	const dataColumns = info.map(tableColumn);
	/**
	 * **列序原样照搬,不把 id 挪到最前。**
	 *
	 * 这一页看的是表本身长什么样,列序就是表的一部分——十一个固定字段的顺序在每张表里
	 * 都一样(由 test:column-order 守着),对照 prisma 看的时候不用来回找。挪一列等于在
	 * 展示层修改事实,而看的人无从知道它被挪过。
	 *
	 * `__rowid__` 是另一回事:没有主键的 SQLite 表只能靠它定位,那不是修饰,是补上一个
	 * 表里没有、但这一页必须有的东西。
	 */
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
