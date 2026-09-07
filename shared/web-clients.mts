/**
 * 站点可以选用的前端。**这份清单与 esbuild 的入口一一对应**，由 `test:web-clients` 守住。
 *
 * 放代码里而不是数据库：清单里的每一项都必须真的构建出一个产物。放进数据库的话，后台
 * 能配出一个 `bundle-vue.js`，而那个文件根本没构建出来——结果是白屏，而且是只在那个域名
 * 上才复现的白屏。放代码里，漏建一个立刻在构建时失败。
 *
 * 选哪一套由**域名**决定（`global_site_hosts.client_key`），不是站点：`m.example.com` 与
 * `www.example.com` 往往指向同一个站点、同一批数据，只是 UI 不同。
 */
export type WebClient = {
	/** 存进 `global_site_hosts.client_key` 的值。空串表示用默认那一套。 */
	key: string;
	/** 后台下拉里显示的名字。 */
	label: string;
	/** 页面壳引用的脚本，位于 `public/` 下。 */
	bundle: string;
	/**
	 * 要额外引的样式表，位于 `public/` 下；不需要就留空。
	 *
	 * antd 那套是 CSS-in-JS，组件自带样式；antd-mobile 的组件只输出类名，样式在单独的
	 * CSS 里——不引的话页面是一堆裸 HTML，能点、数据也对，就是完全没有样子，而控制台里
	 * 一个错都不报。
	 */
	stylesheet?: string;
	/** 源码入口，esbuild 用它构建上面那个产物。 */
	entry: string;
};

export const WEB_CLIENTS: readonly WebClient[] = [
	{ key: 'antd', label: 'Ant Design（电脑版）', bundle: 'bundle.js', entry: 'clients/antd/index.tsx' },
	{ key: 'antd-mobile', label: 'Ant Design Mobile（手机版）', bundle: 'bundle-antd-mobile.js', stylesheet: 'bundle-antd-mobile.css', entry: 'clients/antd-mobile/index.tsx' },
];

/** 没配或者配了一个已经下线的 key 时用哪一套。 */
export const DEFAULT_WEB_CLIENT = WEB_CLIENTS[0];

/**
 * 按 key 找一套前端。**认不出就回落到默认那一套，而不是报错或白屏**：域名配置是运维
 * 改的，而这里一旦拿不到结果，整个站点就打不开——回落至少让人还能进后台把它改回来。
 */
export const webClientFor = (key: string | null | undefined): WebClient => (
	WEB_CLIENTS.find((client) => client.key === key) ?? DEFAULT_WEB_CLIENT
);
