import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';

/**
 * 这个子树只接受这两种方法。**一处声明，两处使用**：预检里告诉浏览器的和实际放行的
 * 必须是同一份，分开写迟早会出现「预检说能用，打过来却被拒」。将来某个叶子确实需要
 * 别的方法时，改这里，两处一起跟上。
 */
const ALLOWED_METHODS = ['POST', 'OPTIONS'];
/** 预检没说要用哪些头时的兜底名单：这条协议自己用到的那几个。 */
const DEFAULT_ALLOWED_HEADERS = 'content-type, x-sms-public-key, x-sms-timestamp, x-sms-nonce, x-sms-signature';

/**
 * 接入方的门。**这一层只拒 cookie，验签名在叶子。**
 *
 * 与 `/api/shortcut/`（静态令牌）、`/api/platform/`（平台预配凭证）并列，按**凭证形态**
 * 分：那两类的凭证只在 `Authorization` 头上，一个头就能在中间件里验完；这一类的凭证虽然
 * 也在请求头上（`X-Sms-Public-Key`/`X-Sms-Timestamp`/`X-Sms-Nonce`/`X-Sms-Signature`），
 * 但验签验的是**请求体的原始字节**，而 body 还要交给叶子做业务，不能在这一层就把它读走
 * 又不传下去——所以还是留在叶子验证，不是纯头部凭证能提前收口的那一类。
 *
 * 不接受 cookie 认证：浏览器会对跨站请求自动附带 cookie，这里若也认会话，任何网页都能
 * 借用户已登录的身份往这些接口打。协议接口的身份跟随请求，不跟随浏览器。
 */
const handler: ApiHandler = async (c, next) => {
	/**
	 * **跨源放行。** 接入方常常从自己的页面直接提交票据，而不是跳到本站的绑定页——那是一个
	 * 跨源请求，浏览器要先看到 CORS 头才肯把它发出去。
	 *
	 * 放到 `*` 在这里是安全的，**恰恰因为这一层不认 cookie**：没有环境权限可借，拿不到票据
	 * 的人打这个接口只会得到一句「签名无效」。反过来说，这两件事是一对：哪天这里开始认会话，
	 * 这个 `*` 必须同时撤掉，否则任何网页都能借用户已登录的身份来打。
	 *
	 * 不发 `Access-Control-Allow-Credentials`——发了浏览器就会把 cookie 带来，而下一句正要拒它。
	 */
	c.header('Access-Control-Allow-Origin', '*');
	/**
	 * **放行接入方问的那些头，而不是我们猜他会送哪些。**
	 *
	 * 原先是一份白名单，只列了这条协议自己用的五个头。接入方的页面多带一个头就过不了
	 * 预检——链路追踪的 `traceparent`、框架自动加的 `x-requested-with` 都是这样，而他在
	 * 控制台看到的只是一句 CORS 错误，服务端日志里一片空白。
	 *
	 * 回声 `Access-Control-Request-Headers` 等价于 `*`，但对老 Safari 也成立——那些版本
	 * 不认 `Allow-Headers: *`，会把通配符当字面量去比。预检没带这个头时退回白名单，保证
	 * 这一行永远不是空的。
	 */
	c.header('Access-Control-Allow-Headers', c.req.header('access-control-request-headers') || DEFAULT_ALLOWED_HEADERS);
	c.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
	// 预检结果缓存一天：这几个头一年也不会变一次，而每次预检都是一个真实的往返。
	c.header('Access-Control-Max-Age', '86400');
	/**
	 * 允许的来源恒为 `*`，照理不随 Origin 变化；但 `Allow-Headers` 现在是照着请求回声的，
	 * 这一条响应确实随请求头而变。中间有缓存时不声明就会串味：A 站问过的那份被原样发给
	 * 问了别的头的 B 站。两个都写上，代价只是一个头。
	 */
	c.header('Vary', 'Origin, Access-Control-Request-Headers', { append: true });
	// 预检不带 body，也不该被业务逻辑看到：它问的只是「这个跨源请求能不能发」。
	if (c.req.method === 'OPTIONS') return c.body(null, 204);
	/**
	 * 方法不对就在这里收口，给确定性的 405。
	 *
	 * 不收的话请求会一路走到叶子，叶子对非 POST 只是 `return next()`，而它后面已经没有
	 * 处理者了——出来的是 500「API route did not return a response」。对接的人拿到 500
	 * 会去查我们的服务是不是挂了，而真相只是他用错了方法。
	 */
	if (!ALLOWED_METHODS.includes(c.req.method)) {
		c.header('Allow', ALLOWED_METHODS.join(', '));
		return apiMessage(c, 405, `这个接口只接受 ${ALLOWED_METHODS.join(' 和 ')}`);
	}
	if (c.req.header('cookie')) return apiMessage(c, 400, '协议接口不接受 cookie 认证：签名本身就是凭证');
	return next();
};

export default handler;
