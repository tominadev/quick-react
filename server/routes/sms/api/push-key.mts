import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { PUBLISHED_KEYS_MAX_AGE_SECONDS, loadPublishedKeys } from '@server/modules/sms/platform-key.mjs';

/**
 * 平台推送公钥。**这是一个公开端点，不需要任何凭证。**
 *
 * 推送时 SMS 用自己的私钥签名，接收方用这里取到的公钥验签（绑定文档 §4.9.2）。与绑定票据
 * 是同一套签名方案、方向相反：那边是接入方签、SMS 验，这边是 SMS 签、接入方验。
 *
 * **公开是它的用途，不是疏忽。** 公钥本来就要发给所有接收方；把它藏在认证后面，接收方
 * 反而要先有一份凭证才能验签，而验签这一步存在的理由正是「不必先信任传输通道」。
 *
 * 密钥在**管理后台**维护（`/panel/admin/sms/platform-keys`），不在环境变量里：同一个系统里
 * 两种密钥两套存法，维护的人得记住哪个在哪；而且轮换要改配置、要重启，没法在后台点两下完成。
 * 私钥与 `global_cloud_credentials.access_key_secret` 同一待遇——能盗库就能拿到，再加一层
 * 可解密的加密只是把钥匙和锁放进同一个抽屉。
 *
 * 公布的是 `active`（当前签名）加 `publishing`（刚生成、还没启用）加 `retiring`（刚换下来、
 * 还在观察期），也就是「不是 retired」的全部。
 *
 * **不发 kid。** 名单里只有公钥本身——推送信封里带的就是公钥，接收方拿它在这份名单里找，
 * 找得到才验签，找不到就当成伪造的丢掉。多给一个 `kid` 只会诱使接收方拿它当键去缓存，
 * 而那是一个由公钥算出来的标签，判定来源的从头到尾都是公钥。后台那一页仍然显示 `kid`，
 * 那是给人念的，不进协议。
 *
 * **过期时间挂在名单上，不挂在单把密钥上。** 接收方要知道的是「我这份缓存还能信多久」，
 * 那是 `max_age_seconds`。给每把密钥标一个 `expires_at` 会是一句平台守不住的承诺：退役是
 * 管理员在后台点出来的，不是到点自动发生的；而密钥一旦泄露，必须能立刻换掉，任何事先
 * 公布的到期时刻在那一刻都作废。接收方要是信了那个时刻，早退役会让他把真推送当伪造丢掉，
 * 晚退役会让他继续信一把已经不该信的公钥——两个方向都错。
 */

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	const keys = await loadPublishedKeys(c.get('database'));
	if (!keys.length) return apiMessage(c, 503, '本站还没有生成推送签名密钥，请在管理后台的「推送密钥」页生成一把');
	// 读得到响应头的客户端不必解析正文就知道能缓存多久；下面正文里是同一个数。
	c.header('cache-control', `public, max-age=${PUBLISHED_KEYS_MAX_AGE_SECONDS}`);
	return apiResponse(c, 200, {
		algorithm: 'Ed25519',
		/**
		 * 数组而不是单个：轮换期间有两把。接收方拿推送信封里的 `publicKey` 在这份名单里
		 * 找，不要假设只有一把、也不要假设第一把就是签名用的那把。
		 */
		keys: keys.map((item) => ({ public_key: item.public_key, status: item.status })),
		/** 这份名单最多缓存这么多秒，与响应头 `Cache-Control: max-age` 是同一个数。 */
		max_age_seconds: PUBLISHED_KEYS_MAX_AGE_SECONDS,
		// 编码规则写进响应，省得接收方去翻文档：全系统一套（§10）。
		encoding: { public_key: 'base64url', signature: 'base64url', signed_input: '信封里 payload 那段字符串的 UTF-8 字节' },
	});
};

export default handler;
