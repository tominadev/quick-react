import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * 浏览器测试的公共引导。
 *
 * 七个 `*-browser` 测试原先各抄一份同样的二十行：挂 window、补 matchMedia、补
 * ResizeObserver。抄件之间已经开始漂移（有的多一个 IntersectionObserver，有的少
 * 一个 MutationObserver），而漂移的表现是「某个测试莫名其妙跑不起来」，没人会想到
 * 去比对七份引导。
 */
export const setupBrowserDom = (url: string, extras?: Record<string, unknown>) => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
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
		CustomEvent: dom.window.CustomEvent,
		getComputedStyle: (element: Element) => dom.window.getComputedStyle(element),
		MutationObserver: dom.window.MutationObserver,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
		...extras,
	});
	Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
	// antd 的 rc-* 系列会探测老 IE 的事件接口；jsdom 没有，探测本身会抛。
	Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
	Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) });
	return dom;
};

/** 元素念成一行开标签，`<button title="清空" class="ant-btn …">`。 */
export const describeElement = (element: Element | null) => {
	if (!element) return 'null';
	const attributes = [...element.attributes].map((item) => ` ${item.name}="${item.value.length > 40 ? `${item.value.slice(0, 40)}…` : item.value}"`).join('');
	return `<${element.tagName.toLowerCase()}${attributes}>`;
};

/**
 * 断言这个元素不存在。
 *
 * **不要写 `assert.equal(screen.queryByX(...), null)`**：node 的 assert 生成差异时用的是
 * `{ depth: 1000, getters: true }`，它会挨个调用 DOM 节点的 getter 再往下钻一千层。一个
 * 普通的按钮就能让进程吃掉几十 G 内存，然后被内核 SIGKILL —— 测试不是「失败」，是
 * 「Killed」，退出码 137，一个字都不告诉你。真正失败的那一行就这么藏了下来。
 *
 * 这里先把节点念成一行字再交给 assert，失败时看到的是那个不该出现的标签本身。
 */
export const assertAbsent = (element: Element | null, message: string) => {
	assert.equal(describeElement(element), 'null', `${message}，却找到了 ${describeElement(element)}`);
};
