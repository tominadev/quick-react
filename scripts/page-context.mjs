/**
 * 读取页面的初始数据，兼容两种启动模式。
 *
 * API 页面启动（CDN 模式，siteSettings.apiBootstrapEnabled，默认开启）下，HTML 文档对所有访客
 * 一致以便被缓存，auth、siteNavigation、pageStatus 都不嵌在文档里，由客户端另取 bootstrapApiPath。
 * 测试因此不能直接断言 HTML 里的 __INITIAL_DATA__，需要按同样的方式再取一次上下文。
 *
 * 注意：取上下文是 API 请求，必须带上 x-device-key。文档导航可以缺省设备键，API 请求不行——
 * validateBaseDevice 会判定失败并顺手删除会话，后续断言会全部失真。调用方通过 headers 传入。
 */
export const readPageContext = async (app, host, path, { cookie, headers = {} } = {}) => {
	// host 可以是纯主机名（默认 http），也可以是带协议的 origin，例如 https://site1.test。
	const origin = host.includes('://') ? host : `http://${host}`;
	const documentHeaders = { accept: 'text/html', ...headers, ...(cookie ? { cookie } : {}) };
	const response = await app.request(`${origin}${path}`, { headers: documentHeaders });
	const document = await response.text();
	const matched = document.match(/__INITIAL_DATA__=(\{.*?\});<\/script>/s);
	// 独立模板页（/page/privacy.html 等）和 wwwroot 静态覆盖不是通用外壳，没有初始数据，
	// 也就没有 auth / siteNavigation / pageStatus。返回空上下文，调用方按 undefined 处理。
	if (!matched) return { response, document, initial: undefined, context: {} };
	const initial = JSON.parse(matched[1]);
	if (initial.bootstrapMode !== 'api') return { response, document, initial, context: initial };
	const apiPath = `${initial.bootstrapApiPath}${initial.bootstrapApiPath.includes('?') ? '&' : '?'}include=auth`;
	const apiResponse = await app.request(`${origin}${apiPath}`, {
		headers: { accept: 'application/json', referer: `${origin}${path}`, ...headers, ...(cookie ? { cookie } : {}) },
	});
	const payload = await apiResponse.json();
	return { response, document, initial, context: { ...initial, ...(payload.context ?? {}) } };
};
