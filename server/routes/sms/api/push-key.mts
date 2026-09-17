import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { loadPublishedKeys } from '@server/modules/sms/platform-key.mjs';

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
 * 公布的是 `active`（当前签名）加 `retiring`（刚换下来、还在观察期）。
 *
 * **接收方按 `public_key` 比对，不按 `kid`。** 推送的信封里带的就是公钥本身，拿它在这份
 * 名单里找，找得到才验签——找不到就该当成伪造的丢掉。`kid` 只是给人看的标签（由公钥算出），
 * 不参与协议判定。
 */

const handler: ApiHandler = async (c, next) => {
	if (c.req.method !== 'GET') return next();
	const keys = await loadPublishedKeys(c.get('database'));
	if (!keys.length) return apiMessage(c, 503, '本站还没有生成推送签名密钥，请在管理后台的「推送密钥」页生成一把');
	return apiResponse(c, 200, {
		algorithm: 'Ed25519',
		/**
		 * 数组而不是单个：轮换期间有两把。接收方拿推送信封里的 `publicKey` 在这份名单里
		 * 找，不要假设只有一把、也不要假设第一把就是签名用的那把。
		 */
		keys: keys.map((item) => ({ kid: item.kid, public_key: item.public_key, status: item.status })),
		// 编码规则写进响应，省得接收方去翻文档：全系统一套（§10）。
		encoding: { public_key: 'base64url', signature: 'base64url', signed_input: '信封里 payload 那段字符串的 UTF-8 字节' },
	});
};

export default handler;
