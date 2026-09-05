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

/**
 * antd 的排序状态与 `<列>:<asc|desc>` 之间的换算。支持多列：逗号分隔，靠前的优先。
 *
 * 优先级按**点击顺序**排，不用 antd 的 `sorter.multiple`——那个是列上写死的固定优先级，
 * 用户点的先后不影响结果，而"先按状态再按时间"和"先按时间再按状态"是两回事。
 */
export type SortEntry = { field: string; order: 'ascend' | 'descend' };

export const parseSort = (sort: string): SortEntry[] => sort.split(',').flatMap((part) => {
	const separator = part.lastIndexOf(':');
	const field = (separator === -1 ? part : part.slice(0, separator)).trim();
	if (!field) return [];
	return [{ field, order: part.slice(separator + 1).trim().toLowerCase() === 'desc' ? 'descend' as const : 'ascend' as const }];
});

export const formatSort = (entries: readonly SortEntry[]) =>
	entries.map((entry) => `${entry.field}:${entry.order === 'descend' ? 'desc' : 'asc'}`).join(',');

export const sortOrderFor = (sort: string, dataIndex: string) =>
	parseSort(sort).find((entry) => entry.field === dataIndex)?.order ?? null;

/**
 * 把 antd 回调里的排序状态合进当前排序。
 *
 * 已经在排的列保持原有先后，新点的列排到末尾——这样"再按某列细分"是往后加一层，
 * 而不是把之前的次序打乱。取消排序的列直接去掉。
 */
export const mergeSort = (sort: string, changed: ReadonlyArray<{ field?: unknown; order?: unknown }>): string => {
	const next = new Map<string, SortEntry['order']>();
	for (const item of changed) {
		const field = Array.isArray(item.field) ? item.field.join('.') : item.field;
		if (typeof field !== 'string' || !field || !item.order) continue;
		next.set(field, item.order === 'descend' ? 'descend' : 'ascend');
	}
	const kept = parseSort(sort).filter((entry) => next.has(entry.field)).map((entry) => ({ field: entry.field, order: next.get(entry.field)! }));
	const added = [...next.keys()].filter((field) => !kept.some((entry) => entry.field === field)).map((field) => ({ field, order: next.get(field)! }));
	return formatSort([...kept, ...added]);
};

/**
 * 合并查询条件的三个来源，后面的压过前面的：
 *
 * 1. 字段自带的 `defaultValue`（后端下发的"没指定时用什么"）
 * 2. 页面传进来的初始值
 * 3. **地址栏**——带着 `?q.status=…` 进来的地址是用户明确选定的，必须赢
 *
 * 审计页默认「待审批」；用户改成「全部」再刷新，如果默认值压过地址栏，他挑的就白挑了。
 */
export const mergeQueryValues = (
	fields: ReadonlyArray<{ dataIndex: string; defaultValue?: unknown }>,
	initial: Record<string, string>,
	fromUrl: Record<string, string>,
): Record<string, string> => ({
	...Object.fromEntries(fields
		.filter((field) => initial[field.dataIndex] !== undefined || (field.defaultValue !== undefined && field.defaultValue !== ''))
		.map((field) => [field.dataIndex, initial[field.dataIndex] ?? String(field.defaultValue)])),
	...initial,
	...fromUrl,
});
