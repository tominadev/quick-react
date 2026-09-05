/**
 * 表格的搜索条件、翻页与排序都记在地址栏里：刷新回到原处，链接也能直接分享出去。
 *
 * 搜索字段带 `q.` 前缀——它们是各表自定义的，不加前缀就会和 `page`、`sort` 这些通用
 * 参数撞名。写入用 replaceState 而不是 pushState：翻了五页再按后退应该离开列表，
 * 而不是一页页倒着退回去。
 */
export type TableUrlState = { page: number; size: number; sort: string; query: Record<string, string> };

export const defaultTableUrlState: TableUrlState = { page: 1, size: 10, sort: '', query: {} };

export const readTableUrlState = (search: string): TableUrlState => {
	try {
		const params = new URLSearchParams(search);
		const query: Record<string, string> = {};
		for (const [key, value] of params) if (key.startsWith('q.')) query[key.slice(2)] = value;
		const page = Number.parseInt(params.get('page') ?? '', 10);
		const size = Number.parseInt(params.get('size') ?? '', 10);
		return {
			page: Number.isInteger(page) && page > 0 ? page : defaultTableUrlState.page,
			size: Number.isInteger(size) && size > 0 ? size : defaultTableUrlState.size,
			sort: params.get('sort') ?? '',
			query,
		};
	} catch { return { ...defaultTableUrlState, query: {} }; }
};

/** 只把非默认值写进地址：默认状态下地址栏保持干净。返回新的查询串（不含 `?`）。 */
export const writeTableUrlState = (search: string, state: Partial<TableUrlState>): string => {
	const params = new URLSearchParams(search);
	const set = (key: string, value: string, isDefault: boolean) => { if (isDefault) params.delete(key); else params.set(key, value); };
	if (state.page !== undefined) set('page', String(state.page), state.page <= defaultTableUrlState.page);
	if (state.size !== undefined) set('size', String(state.size), state.size === defaultTableUrlState.size);
	if (state.sort !== undefined) set('sort', state.sort, !state.sort);
	if (state.query) {
		for (const key of [...params.keys()]) if (key.startsWith('q.')) params.delete(key);
		for (const [key, value] of Object.entries(state.query)) if (value !== '' && value !== undefined && value !== null) params.set(`q.${key}`, String(value));
	}
	return params.toString();
};

/** antd 的排序状态与 `<列>:<asc|desc>` 之间的换算。 */
export const sortOrderFor = (sort: string, dataIndex: string) => {
	const [field, direction] = sort.split(':');
	return field === dataIndex ? (direction === 'desc' ? 'descend' as const : 'ascend' as const) : null;
};
export const sortParameter = (field: unknown, order: unknown) => (
	order && field ? `${String(field)}:${order === 'descend' ? 'desc' : 'asc'}` : ''
);
