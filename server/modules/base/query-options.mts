import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';

const queryValues = (c: Context<AppEnv>, name: string) => (c.req.query(name) ?? '')
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean);

export const queryIncludes = (c: Context<AppEnv>, name: string, value: string) => queryValues(c, name).includes(value.toLowerCase());

/** 删除记录默认排除；只有明确 include=deleted 且没有 exclude=deleted 才进入回收站范围。 */
export const deletedScopeFromQuery = (c: Context<AppEnv>) => (
	queryIncludes(c, 'include', 'deleted') && !queryIncludes(c, 'exclude', 'deleted') ? 'deleted' as const : 'active' as const
);

/** 排序方向只有两个取值；其余一律当升序，不为一个拼错的方向让整次查询失败。 */
export type SortDirection = 'ASC' | 'DESC';
export type SortRequest = { field: string; direction: SortDirection };

/**
 * 解析 `?sort=<字段>:<asc|desc>`。字段名用的是表格列的 dataIndex，不是数据库列名——
 * 两者的映射由路由给出（见 tableOrderBy），因此请求里出现的任何名字都只是查表的键，
 * 拼不进 SQL。
 */
export const sortFromQuery = (c: Context<AppEnv>): SortRequest | undefined => {
	const raw = (c.req.query('sort') ?? '').trim();
	if (!raw) return undefined;
	const separator = raw.lastIndexOf(':');
	const field = (separator === -1 ? raw : raw.slice(0, separator)).trim();
	if (!field) return undefined;
	const direction = raw.slice(separator + 1).trim().toLowerCase() === 'desc' ? 'DESC' as const : 'ASC' as const;
	return { field, direction };
};

/**
 * 交给列表查询的排序参数。查询执行时会回调 expose，把它选出的列名记到请求上下文里，
 * 响应层据此标注哪些列可排序（见 api-response 的 withTableUtilities）。
 *
 * 这样「能排序的列」永远等于「这条查询选出来的列」，加列减列都不用再改别处。
 */
export const tableSort = (c: Context<AppEnv>) => ({
	request: sortFromQuery(c),
	expose: (fields: string[]) => c.set('sortableFields', fields),
});

/** 列定义里标注哪些列可排序：能排的就是这张表选出来的列。 */
export const sortableColumns = <T extends { dataIndex: string }>(columns: readonly T[], selected: readonly string[]) => {
	const allowed = new Set(selected);
	return columns.map((column) => (allowed.has(column.dataIndex) ? { ...column, sortable: true } : column));
};
