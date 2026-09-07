import type { DataType, ResJsonTable } from '@/utils/common/api.js';
import type { TableAction } from '@shared/types/table.mjs';
import { CHANGE_CONTROL_FIELD } from '@shared/table-form.mjs';

/**
 * 表格 CRUD 的**协议层**：请求怎么构造、响应怎么读、动作对哪一行可见。
 *
 * 这里没有任何渲染。剥出来是因为这些规则是**后端驱动 UI 协议的一部分**——第二套 UI
 * （elementUI、手机版、小程序）必须一字不差地照做，否则同一个后端会在两个前端上表现不同：
 * `include` 算错就会每次翻页都重取一遍结构，`visibleWhen` 判错就会把「回滚」按钮显示在
 * 一条已经回滚过的记录上。这种漂移在代码复制的那一刻看不出来，要等用户报障才发现。
 */

/**
 * 这一次请求要带哪些 `include`。
 *
 * **首次取结构和数据，之后只取数据**（架构文档的 include 协议）：结构是列定义、动作、
 * 查询字段那一套，翻一次页重发一遍纯属浪费，而它在同一张表上不会变。回收站等业务
 * include 原样保留——它们决定的是「取哪一批行」，与结构无关。
 */
export const nextIncludes = (current: string | undefined, schemaLoaded: boolean): string | undefined => {
	const includes = new Set((current ?? '').split(',').map((value) => value.trim()).filter(Boolean));
	includes.add('data');
	if (schemaLoaded) includes.delete('schema');
	else includes.add('schema');
	return includes.size ? [...includes].join(',') : undefined;
};

/** 列表请求的查询参数。游标只在那一页真有游标时才带——带一个空的会被当成「从头开始」。 */
export const tableRequestQuery = (options: {
	page: number;
	pageSize: number;
	sort?: string;
	cursor?: string;
	queryValues: Record<string, string>;
	schemaLoaded: boolean;
}): Record<string, string> => {
	const query: Record<string, string> = {
		pageNum: String(options.page || 0),
		pageSize: String(options.pageSize || 0),
		...(options.sort ? { sort: options.sort } : {}),
		...(options.cursor ? { cursor: options.cursor } : {}),
		...options.queryValues,
	};
	// include 是公共响应协议参数，优先级高于业务查询字段——业务字段里同名的会被盖掉。
	const includes = nextIncludes(query.include, options.schemaLoaded);
	if (includes) query.include = includes;
	else delete query.include;
	return query;
};

/**
 * 翻页器该显示多少条。
 *
 * 游标分页**不知道总数**：对象存储那种接口只回「还有没有下一页」。所以拿「已经翻过的
 * 页数 × 每页条数 + 这一页的条数 + （还有下一页 ? 1 : 0）」当总数——多出来的那个 1 让
 * 翻页器把「下一页」点亮，而不是显示一个假的准确总数。
 *
 * 服务端给了 `totalRecords`（普通分页）就用它，那才是真的。
 */
export const pageTotal = (options: { page: number; pageSize: number; currentCount: number; hasMore?: boolean; totalRecords?: number }) => (
	options.hasMore === undefined
		? options.totalRecords
		: (options.page - 1) * options.pageSize + options.currentCount + (options.hasMore ? 1 : 0)
);

/**
 * 这个动作对这一行可见吗。
 *
 * 按行过滤互斥动作：撤回只对已生效的行有意义，恢复只对已撤回的行有意义——一行上永远
 * 只该出现其中一个。判据由**服务端**声明（`visibleWhen`），前端不按 key 名去猜。
 */
export const actionVisibleForRow = (action: TableAction, record: DataType) => (
	!action.visibleWhen || action.visibleWhen.values.includes(String(record[action.visibleWhen.field] ?? ''))
);

/** 提交前摘掉控制字段：它们走请求头，不是业务字段。 */
export const withoutControlFields = (values: Record<string, unknown>) => {
	const { [CHANGE_CONTROL_FIELD]: _control, ...rest } = values;
	return rest;
};

/** 行动作的确认文案里可以插本行的列值：`确认删除 {user_name} 吗？` */
export const rowConfirmText = (template: string, record: DataType) => template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, field: string) => {
	const value = record[field];
	return value === undefined || value === null || value === '' ? placeholder : String(value);
});

/** 文件大小读成人话。上传进度条上要显示「3.20 MB / 10.00 MB」。 */
export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

/** 响应里带没带表结构——带了就说明这一次是「取结构」，之后的请求可以只要数据。 */
export const responseHasSchema = (table: ResJsonTable | undefined) => Boolean(table && ('option' in table || 'columns' in table));
