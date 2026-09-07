/**
 * 表格的搜索条件、翻页与排序都记在地址栏里：刷新回到原处，链接也能直接分享出去。
 *
 * 搜索字段带 `q.` 前缀——它们是各表自定义的，不加前缀就会和 `page`、`sort` 这些通用
 * 参数撞名。写入用 replaceState 而不是 pushState：翻了五页再按后退应该离开列表，
 * 而不是一页页倒着退回去。
 */
/**
 * 搜索框的值是**三态**的：`null` 是「未填写」——不加这个条件；空串是「填了，填的是空」——
 * 去找空的那些行；有字就按字筛。
 *
 * 原先只有字符串，空串既表示「没填」又表示「填了空」，于是**根本没有办法搜空值**：
 * 想找出哪几行的备注是空的，把框清掉就等于取消筛选。压成两态丢掉的那一位信息，
 * 下游谁也补不回来。
 *
 * 地址栏天生分得开：`?q.reason=` 是空串，参数整个不在就是未填写。
 */
export type TableQueryValues = Record<string, string | null>;

export type TableUrlState = { page: number; size: number; sort: string; query: TableQueryValues };

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
		// 空串照写，写成 `q.reason=`：那是「搜空值」这个条件本身，不是「没有条件」。
		// 只有 null（未填写）才不出现在地址里。
		for (const [key, value] of Object.entries(state.query)) if (value !== undefined && value !== null) params.set(`q.${key}`, value);
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
	fields: ReadonlyArray<{ dataIndex: string; defaultValue?: string }>,
	initial: TableQueryValues,
	fromUrl: TableQueryValues,
): TableQueryValues => ({
	// 每个声明过的字段都占一条，没有默认值就是 null（未填写）——先有这一条，
	// 后面「用户把它清成未填写」才有得可写：缺席和 null 在这里必须是同一件事的两种写法。
	...Object.fromEntries(fields.map((field) => [field.dataIndex, field.defaultValue ?? null])),
	...initial,
	...fromUrl,
});

/**
 * 该写进地址栏的那几个查询条件：**与默认值不同的才写**。
 *
 * 默认值不写，是和 `page`/`size`/`sort` 同一条规矩——默认状态下地址栏保持干净。
 * 都写进去的话，什么都没挑就跳成 `?q.review_status=all&q.data_status=all&q.scope=all`，
 * 三个参数说的都是「不筛选」。
 *
 * 不写也不会让界面和地址栏对不上：参数缺失时前端回落到 `defaultValue`、服务端回落到
 * 同一个值，而这两个默认值来自同一份路由声明。
 */
export const queryUrlValues = (
	fields: ReadonlyArray<{ dataIndex: string; defaultValue?: string }>,
	values: TableQueryValues,
): TableQueryValues => {
	const defaults = new Map(fields.map((field) => [field.dataIndex, field.defaultValue ?? null]));
	// 没声明过的字段（`include` 那一类）默认按 null 算：它们本来就不属于这一排搜索框。
	return Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== (defaults.has(name) ? defaults.get(name)! : null)));
};

/**
 * 三态查询值换成请求参数：**未填写的整个不发**，填了空的发一个空值（`reason=`）。
 *
 * 服务端因此照样是三态——`c.req.query('reason')` 拿到 undefined 是没这个条件，
 * 拿到空串是要找空的。中间这一层只负责把「未填写」这件事表达成「参数不在」，不做解释。
 */
export const queryRequestValues = (values: TableQueryValues): Record<string, string> =>
	Object.fromEntries(Object.entries(values).flatMap(([name, value]) => value === null || value === undefined ? [] : [[name, value] as const]));

/**
 * 把地址栏上的表格状态换成接口参数。
 *
 * 地址栏用 `page`/`size`/`q.<字段>`，接口用 `pageNum`/`pageSize`/`<字段>`——两套名字
 * 各有各的理由（地址要短、要能和搜索字段区分开；接口要和既有协议一致），换算只此一处。
 *
 * **只带地址栏里真有的东西**：地址上什么都没写时返回空，接口照常用它自己的默认值。
 */
export const tableRequestParams = (search: string): Record<string, string> => {
	const params = new URLSearchParams(search);
	const state = readTableUrlState(search);
	return {
		...(params.has('page') ? { pageNum: String(state.page) } : {}),
		...(params.has('size') ? { pageSize: String(state.size) } : {}),
		...(state.sort ? { sort: state.sort } : {}),
		...state.query,
	};
};
