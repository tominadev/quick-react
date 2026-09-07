import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const navigation = ['a', 'b', 'c'].map((key) => ({
	key: `/panel/${key}`,
	label: `菜单 ${key.toUpperCase()}`,
	icon: 'appstore',
	component: 'table',
	title: `菜单 ${key.toUpperCase()}`,
}));
const auth = { component: 'buttons', actions: [], pages: [] } as const;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://site.test/panel/a.html' });
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
(window as Window & { __INITIAL_DATA__?: unknown }).__INITIAL_DATA__ = {
	bootstrapMode: 'api',
	bootstrapApiPath: '/api/panel/a.php',
	apiSuffix: '.php',
	pageSuffix: '.html',
	siteName: '测试站点',
	siteNavigation: [],
};

const React = await import('react');
const { render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { MemoryRouter } = await import('react-router-dom');
const { App } = await import('../clients/web/App.js');

const table = (key: string) => ({
	option: { rowKey: 'id' },
	columns: [{ dataIndex: 'name', title: '名称' }],
	dataSource: [{ id: key, name: `${key.toUpperCase()} 数据` }],
	totalRecords: 1,
});
const requests: string[] = [];
const commonApi = {
	apiFetch: async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		if (url.startsWith('/api/panel/a.php?include=auth')) return new Response(JSON.stringify({
			context: { auth, siteNavigation: navigation },
			table: table('a'),
		}), { headers: { 'content-type': 'application/json' } });
		const key = url.match(/\/api\/panel\/([abc])\.php/)?.[1];
		assert.ok(key, `未处理的请求：${url}`);
		return new Response(JSON.stringify({ table: table(key) }), { headers: { 'content-type': 'application/json' } });
	},
	modalConfirm: async () => true,
	modalError: async () => undefined,
	uploadFile: async () => undefined,
};

render(React.createElement(MemoryRouter, { initialEntries: ['/panel/a.html'] }, React.createElement(App, { commonApi })));
const user = userEvent.setup({ document: dom.window.document });
await waitFor(() => assert.ok(screen.getByText('A 数据')));

const clickMenu = async (label: string) => {
	await user.click(screen.getAllByText(label)[0]!);
};
await clickMenu('菜单 B');
await waitFor(() => assert.ok(screen.getByText('B 数据')));
await clickMenu('菜单 C');
await waitFor(() => assert.ok(screen.getByText('C 数据')));
await clickMenu('菜单 A');
await waitFor(() => assert.ok(screen.getByText('A 数据')));

assert.ok(
	requests.some((url) => url.startsWith('/api/panel/a.php?pageNum=')),
	'离开刷新时的首屏菜单后再次返回，必须重新请求该菜单的数据接口',
);
console.log('menu revisit browser test passed');
