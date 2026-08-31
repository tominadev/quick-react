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
