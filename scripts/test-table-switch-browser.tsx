import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://site.test/panel/admin/base/data/rows.html' });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	HTMLBodyElement: dom.window.HTMLBodyElement,
	HTMLHtmlElement: dom.window.HTMLHtmlElement,
	Element: dom.window.Element,
	SVGElement: dom.window.SVGElement,
	ShadowRoot: dom.window.ShadowRoot,
	Node: dom.window.Node,
	getComputedStyle: (element: Element) => dom.window.getComputedStyle(element),
	MutationObserver: dom.window.MutationObserver,
});
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;

const React = await import('react');
const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { MemoryRouter } = await import('react-router-dom');
const TableCRUD = (await import('../src/utils/antd/table_crud/index.js')).default;

const queryFields = [{ dataIndex: 'table', label: '数据表', component: 'select', defaultValue: 'table_a', reloadSchema: true, options: [{ value: 'table_a', text: 'table_a' }, { value: 'table_b', text: 'table_b' }] }];
// 第一张表：有行操作和工具栏批量删除。
const tableA = {
	option: { rowKey: 'id', queryFields, actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'delete', label: '删除' }, { key: 'recycle-bin', label: '回收站', modalPath: '/panel/admin/base/data/rows', modalComponent: 'table' }], row: [{ key: 'edit', label: '编辑' }] } },
	columns: [{ dataIndex: 'name', title: '名称', component: 'textbox' }],
	dataSource: [{ id: 'acct_string_id', name: 'A 行' }],
	totalRecords: 1,
};
// 第二张表整体没有 actions：合并语义下会残留上一张表的按钮。行键故意与上一张表相同，用来暴露选中状态残留。
const tableB = {
	option: { rowKey: 'key', queryFields },
	columns: [{ dataIndex: 'title', title: '标题', component: 'textbox' }],
	dataSource: [{ key: 'acct_string_id', title: 'B 行' }],
	totalRecords: 1,
};

const requests: string[] = [];
const commonApi = {
	apiFetch: async (url: string) => {
		requests.push(String(url));
		if (String(url).includes('/acct_string_id')) return new Response(JSON.stringify({ id: 'acct_string_id', name: 'A 行' }), { headers: { 'content-type': 'application/json' } });
		if (String(url).includes('include=deleted')) return new Response(JSON.stringify({ table: { ...tableA, dataSource: [{ id: 'deleted_id', name: '已删除行' }] } }), { headers: { 'content-type': 'application/json' } });
		const table = String(url).includes('table=table_b') ? tableB : tableA;
		if (String(url).includes('include=data')) return new Response(JSON.stringify({ table: { dataSource: table.dataSource, totalRecords: table.totalRecords } }), { headers: { 'content-type': 'application/json' } });
		return new Response(JSON.stringify({ table }), { headers: { 'content-type': 'application/json' } });
	},
	modalConfirm: async () => true,
};

const user = userEvent.setup({ document: dom.window.document });
// API 启动模式会把首个完整响应直接交给 TableCRUD。初始化默认查询值更新状态后，
// 第一次点击搜索仍必须发起数据请求，不能被初始化 effect 的跳过逻辑吞掉。
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, {
	commonApi,
	resourcePath: '/panel/admin/base/data/rows',
	initialResponse: { table: tableA },
})));
await waitFor(() => assert.ok(screen.getByText('A 行')));
const requestCountBeforeSearch = requests.length;
await user.click(screen.getByRole('button', { name: /搜索/ }));
await waitFor(() => assert.ok(requests.length > requestCountBeforeSearch, '首次点击搜索必须发起 HTTP 请求'));
assert.ok(requests.at(-1)?.includes('include=data'), '首次搜索应复用已加载的表结构');

cleanup();
requests.length = 0;
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, { commonApi, resourcePath: '/panel/admin/base/data/rows' })));
await waitFor(() => assert.ok(screen.getByText('A 行')));
assert.ok(screen.getByText('编辑'), '第一张表有行操作');
assert.ok(screen.getByRole('button', { name: /删除/ }), '第一张表有工具栏删除');

// 回收站复用当前资源接口；隐藏的 deleted 参数在初始化加载和查询条件同步时都不能丢失，且只允许发起一次请求。
const requestCountBeforeRecycle = requests.length;
await user.click(screen.getByRole('button', { name: /回收站/ }));
await waitFor(() => assert.ok(screen.getByText('已删除行')));
const recycleRequests = requests.slice(requestCountBeforeRecycle).filter((url) => url.includes('/panel/admin/base/data/rows'));
assert.equal(recycleRequests.length, 1, '打开回收站只应请求一次当前资源接口');
	assert.ok(recycleRequests[0]?.includes('table=table_a') && recycleRequests[0]?.includes('include=deleted'), '回收站请求必须保留当前表和 include=deleted 参数');
await user.click(screen.getByRole('button', { name: 'Close' }));

// 操作列必须使用同一次后端响应中的字符串 rowKey，不能捕获首次渲染的默认 key。
await user.click(screen.getByText('编辑'));
await waitFor(() => assert.ok(requests.some((url) => url.includes('/acct_string_id'))));
cleanup();
requests.length = 0;
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, { commonApi, resourcePath: '/panel/admin/base/data/rows' })));
await waitFor(() => assert.ok(screen.getByText('A 行')));

// 选中一行后切换数据表。
const checkbox = document.querySelectorAll('tbody input[type="checkbox"]')[0] as HTMLInputElement;
await user.click(checkbox);
await waitFor(() => assert.equal((screen.getByRole('button', { name: /删除/ }) as HTMLButtonElement).disabled, false, '选中后批量删除可用'));

// 页面上还有分页的页数选择器，查询条件的下拉是第一个。
const select = screen.getAllByRole('combobox')[0];
await user.click(select);
// antd 下拉会渲染多个同名节点，点最后一个真实选项。
await user.click((await screen.findAllByText('table_b')).at(-1)!);
await user.click(screen.getByRole('button', { name: /搜索/ }));
await waitFor(() => assert.ok(screen.getByText('B 行')));

// 切表后：上一张表的行操作和工具栏都不能残留，选中状态也要清空。
assert.equal(screen.queryByText('编辑'), null, '上一张表的行操作不应该残留');
assert.equal(screen.queryByRole('button', { name: /^删除$/ }), null, '上一张表的工具栏不应该残留');
assert.equal(screen.queryByText('A 行'), null);
assert.equal(document.querySelectorAll('tbody input[type="checkbox"]:checked').length, 0, '切表后不应该还有选中行');
assert.equal(screen.queryByRole('button', { name: /搜索/ }), null, '新表没有查询动作时按钮也不应该残留');

// 首次加载后直接点编辑：行操作必须带上**已生效的查询条件**。
// 这些闭包是在异步回调里构建的，如果在渲染时求值就会捕获初始的空条件——
// 「表列管理」点编辑会因此丢掉 table 参数，报「请选择数据表」，
// 而切换数据表再搜索会重建列定义，于是又正常了。
cleanup();
requests.length = 0;
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, { commonApi, resourcePath: '/panel/admin/base/data/columns' })));
await waitFor(() => assert.ok(screen.getByText('A 行')));
await user.click(screen.getByText('编辑'));
await waitFor(() => assert.ok(requests.some((url) => url.includes('/acct_string_id'))));
const editRequest = requests.find((url) => url.includes('/acct_string_id'))!;
assert.ok(editRequest.includes('table=table_a'), `编辑请求必须带上已生效的查询条件：${editRequest}`);

// 查询输入框里按回车应该等同于点搜索：查询区不在 form 里，没有默认提交行为可拦，
// 所以必须显式接 onPressEnter。
cleanup();
requests.length = 0;
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, {
	commonApi,
	resourcePath: '/panel/admin/base/data/rows',
	initialResponse: { table: { ...tableA, option: { ...tableA.option, queryFields: [...queryFields, { dataIndex: 'keyword', label: '关键字', component: 'textbox', placeholder: '输入关键字' }] } } },
})));
await waitFor(() => assert.ok(screen.getByText('A 行')));
// antd 的 Select 自己也渲染一个 input，按 placeholder 精确定位关键字框。
const keyword = screen.getByPlaceholderText('输入关键字');
await user.click(keyword);
await user.keyboard('abc');
const requestCountBeforeEnter = requests.length;
await user.keyboard('{Enter}');
await waitFor(() => assert.ok(requests.length > requestCountBeforeEnter, '回车必须发起搜索请求'));
assert.ok(requests.at(-1)?.includes('keyword=abc'), `回车后的请求要带上输入的条件：${requests.at(-1)}`);

// 列带 group 时编辑抽屉分 Tab；两组的字段都要提交上去。
// Tab 默认懒渲染，没渲染过的 Form.Item 不会注册到表单——不 forceRender 的话
// 另一组会整个丢掉，而用户根本察觉不到自己漏填了什么。
cleanup();
requests.length = 0;
const grouped = {
	option: { rowKey: 'id', actions: { row: [{ key: 'edit', label: '编辑' }] } },
	columns: [
		{ dataIndex: 'name', title: '名称', component: 'textbox', group: '基础设置' },
		{ dataIndex: 'note', title: '备注', component: 'textbox', group: '个人简介' },
	],
	dataSource: [{ id: 'acct_string_id', name: 'A 行', note: '备注内容' }],
	totalRecords: 1,
};
const groupedApi = {
	...commonApi,
	apiFetch: async (url: string, init?: RequestInit) => {
		requests.push(String(url));
		if (init?.method === 'PUT') { requests.push(`PUT-BODY ${String(init.body)}`); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }
		if (String(url).includes('/acct_string_id')) return new Response(JSON.stringify({ id: 'acct_string_id', name: 'A 行', note: '备注内容' }), { headers: { 'content-type': 'application/json' } });
		return new Response(JSON.stringify({ table: grouped }), { headers: { 'content-type': 'application/json' } });
	},
};
render(React.createElement(MemoryRouter, null, React.createElement(TableCRUD, { commonApi: groupedApi, resourcePath: '/panel/admin/base/users', initialResponse: { table: grouped } })));
await waitFor(() => assert.ok(screen.getByText('A 行')));
await user.click(screen.getByText('编辑'));
await waitFor(() => assert.ok(screen.getByRole('tab', { name: '基础设置' })));
assert.ok(screen.getByRole('tab', { name: '个人简介' }), '第二个分组要渲染成 Tab');
// antd 会给两个汉字的按钮插一个空格，无障碍名是「确 定」而不是「确定」。
await user.click(screen.getByRole('button', { name: /确\s*定/ }));
await waitFor(() => assert.ok(requests.some((entry) => entry.startsWith('PUT-BODY'))));
const submitted = JSON.parse(requests.find((entry) => entry.startsWith('PUT-BODY'))!.slice('PUT-BODY '.length)) as Record<string, unknown>;
assert.equal(submitted.name, 'A 行');
assert.equal(submitted.note, '备注内容', '未激活分组的字段也必须提交上去');

console.log('table switch browser test passed');
