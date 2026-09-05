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
 * 把请求里的排序换成 SQL 的 orderBy。
 *
 * `columns` 直接传 select() 用的那份列映射（dataIndex → 数据库列），因此**能排序的列
 * 恰好就是这张表选出来的列**，不需要另维护一份白名单，也不会漏掉或多出。请求里给了
 * 不在其中的字段就回落到默认排序——那多半是换了页面结构后浏览器还留着旧地址。
 */
export const tableOrderBy = (
	c: Context<AppEnv>,
	columns: Record<string, unknown>,
	fallback: Array<{ column: string; direction?: SortDirection }>,
) => {
	const sort = sortFromQuery(c);
	if (!sort) return fallback;
	const mapped = columns[sort.field];
	const column = typeof mapped === 'string' ? mapped : (mapped && typeof mapped === 'object' && 'column' in mapped ? String((mapped as { column: unknown }).column) : '');
	if (!column) return fallback;
	// 次序里补上默认排序：按状态之类重复值很多的列排时，同值行之间还要有个稳定的次序，
	// 否则翻页会看到同一行出现两次、另一行一次都不出现。
	return [{ column, direction: sort.direction }, ...fallback];
};

/** 列定义里标注哪些列可排序：能排的就是这张表选出来的列。 */
export const sortableColumns = <T extends { dataIndex: string }>(columns: readonly T[], selected: Record<string, unknown>) =>
	columns.map((column) => (column.dataIndex in selected ? { ...column, sortable: true } : column));
