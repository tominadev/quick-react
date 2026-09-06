import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';

/**
 * 平台推送公钥。**这是一个公开端点，不需要任何凭证。**
 *
 * 推送时 SMS 用自己的私钥签名，接收方用这里取到的公钥验签（绑定文档 §4.9.2）。与绑定票据
 * 是同一套签名方案、方向相反：那边是接入方签、SMS 验，这边是 SMS 签、接入方验。
 *
 * **公开是它的用途，不是疏忽。** 公钥本来就要发给所有接收方；把它藏在认证后面，接收方
 * 反而要先有一份凭证才能验签，而验签这一步存在的理由正是「不必先信任传输通道」。
 *
 * **密钥不进数据库**（§4.9.1）。私钥放在平台密钥存储里，公钥也从环境读——两个都配，
 * 而不是从私钥推导：Ed25519 的 WebCrypto 在 Node 与 Cloudflare Workers 上的支持有差异
 * （§10 要求先用同一测试向量在两端各跑通），从私钥导公钥这一步在两个运行时上写法不同，
 * 而运维在生成密钥对时本来就两个都拿得到，配两个变量没有额外负担。
 *
 * ```dotenv
 * SMS_PUSH_PUBLIC_KEY=<32 字节 Ed25519 公钥的 Base64URL，43 个字符>
 * SMS_PUSH_SIGNING_KEY=<私钥，签名时用；本期推送尚未实现，端点先把公钥公布出去>
 * ```
 *
 * `kid` 由公钥自身算出（SHA-256 前 16 位十六进制），不另配一个变量：换了公钥 `kid` 自动
 * 跟着变，接收方据此判断缓存的那把是不是还有效，而运维少一个会配错、会忘记同步的地方。
 */

const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	/**
	 * 两个运行时的环境来源不同：Workers 走 `c.env` 绑定，Node 走 `process.env`，而
	 * `process` 在 Workers 上根本不存在——直接读会抛 ReferenceError，整个端点变成 500。
	 * 先看绑定、再看进程环境，两边都能配。
	 */
	const publicKey = String(
		(c.env as Record<string, unknown> | undefined)?.SMS_PUSH_PUBLIC_KEY
		?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SMS_PUSH_PUBLIC_KEY
		?? '',
	).trim();
	if (!publicKey) return apiMessage(c, 503, '本站还没有配置推送签名公钥（SMS_PUSH_PUBLIC_KEY）');
	// 配错了要当场说清楚：接收方拿到一把不合法的公钥，只会在验签时报一句「签名无效」，
	// 那时排查的方向完全错了——他会去怀疑签名，而不是怀疑这把公钥。
	if (!publicKeyPattern.test(publicKey)) return apiMessage(c, 500, '配置的推送签名公钥格式不对：应当是 Ed25519 原始字节的 Base64URL，43 个字符');
	const bytes = Uint8Array.from(atob(publicKey.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
	const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
	return apiResponse(c, 200, {
		algorithm: 'Ed25519',
		kid: digest.slice(0, 16),
		public_key: publicKey,
		// 编码规则写进响应，省得接收方去翻文档：全系统一套（§10）。
		encoding: { public_key: 'base64url', signature: 'base64url', signed_input: 'timestamp + "." + 原始请求体字节' },
	});
};

export default handler;
