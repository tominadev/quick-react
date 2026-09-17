/**
 * HTTPS 监听的 TLS 选项。**单独一处,好让测试能真的把它立起来跑一遍。**
 *
 * 内联在启动流程里的话，验证它就得导入整个 app.mts——那个模块一被导入就跑迁移、连库、
 * 开监听，测不了一个「握手能不能成」这么小的事，于是它就不会被测，于是 `allowHTTP1`
 * 这种缺一个字段的问题只能等线上有人打不开才发现。
 */
export type HttpsCertificate = { key: Buffer | string; cert: Buffer | string };

/**
 * **`allowHTTP1` 必须开着。**
 *
 * `createSecureServer` 默认只认 ALPN 协商出 `h2` 的连接，HTTP/1.1 的 TLS 客户端连握手都
 * 过不去，报的是 `tlsv1 alert no application protocol`——对面看到的既不是 404 也不是 500，
 * 而是一个连不上的 TLS 错误，极难对上号。而 HTTP/1.1 的客户端到处都是：回源的 CDN、
 * curl 默认、健康检查、老一点的库。开着它就是把 h2 与 http/1.1 一起放进 ALPN，各取所需。
 */
export const secureServerOptions = (certificate: HttpsCertificate) => ({
	key: certificate.key,
	cert: certificate.cert,
	allowHTTP1: true,
});
