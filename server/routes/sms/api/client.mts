import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';

/**
 * 接入方的门。**这一层只拒 cookie，验票据在叶子。**
 *
 * 与 `/api/shortcut/`（静态令牌）、`/api/platform/`（平台预配凭证）并列，按**凭证形态**
 * 分：这一类的凭证是**请求体里的一次性签名票据**，而那两类在 `Authorization` 头上。
 * 头能在中间件里验完，票据不能——它在 body 里，而 body 还要交给叶子做业务。
 *
 * 不接受 cookie 认证：浏览器会对跨站请求自动附带 cookie，这里若也认会话，任何网页都能
 * 借用户已登录的身份往这些接口打。协议接口的身份跟随请求，不跟随浏览器。
 *
 * **绑定页面本身是静态页**，它读 URL 片段里的票据再 AJAX 提交到这里——片段不进 Referer、
 * 不进服务器访问日志、不进第三方分析。
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
	c.header('Access-Control-Allow-Headers', 'content-type');
	c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
	c.header('Access-Control-Max-Age', '600');
	// 预检不带 body，也不该被业务逻辑看到：它问的只是「这个跨源请求能不能发」。
	if (c.req.method === 'OPTIONS') return c.body(null, 204);
	if (c.req.header('cookie')) return apiMessage(c, 400, '协议接口不接受 cookie 认证：票据本身就是凭证');
	return next();
};

export default handler;
