import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { sha256 } from '@server/modules/passport/accounts/oidc.mjs';

/**
 * 平台预配凭证的门。**这一层验完凭证，叶子只管业务。**
 *
 * `/api/platform/*` 下的接口由**平台自己运维的 Mac** 调用——生成 `.shortcut` 文件需要 macOS
 * 本机的签名工具链，服务端代劳不了，因此必须有一台跑生成器的机器。凭证一台一份，随 `.env`
 * 下发，只存哈希（绑定文档 §4.10、§4.11）。
 *
 * 这类凭证**不属于任何账号**：它不能提交短信，也不能绑定手机，只能登记令牌、申请上传、
 * 提交入库。因此这一层解析出来的主体是「机器」而不是「账号」——叶子据此就知道自己拿不到
 * `ownerUid`，也就不会误用归属上下文去写用户数据。
 *
 * **一层熔断，一处验证**：拒 cookie、取 Bearer、算摘要、查机器、解析主体。
 */

/** 恒时比较，理由同 shortcut.mts：查表已是等值匹配，这一步是防将来有人改成前缀查再比对。 */
const timingSafeEqual = (left: string, right: string) => {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return diff === 0;
};

const handler: ApiHandler = async (c, next) => {
	if (c.req.header('cookie')) return apiMessage(c, 400, '协议接口不接受 cookie 认证，请改用 Authorization 头');
	const authorization = (c.req.header('authorization') ?? '').trim();
	if (!/^Bearer\s+\S/i.test(authorization)) return apiMessage(c, 401, '缺少 Authorization: Bearer 凭证');
	const database = c.get('database');
	const secret = authorization.replace(/^Bearer\s+/i, '').trim();
	// 凭证无效与机器停用回同一句话：能拿到凭证的人不该再多得到一个「这台机器是不是被停了」的答案。
	const refuse = () => apiMessage(c, 401, '生成器凭证无效或机器已停用');

	const digest = await sha256(secret);
	const machine = await firstSql<{ id: string; name: string; secret_hash: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_generator_machines',
		columns: { id: { column: 'id', cast: 'text' }, name: 'name', secret_hash: 'secret_hash', status: 'status' },
		where: [{ column: 'secret_hash', value: digest }],
		limit: 1,
	}));
	if (!machine || !timingSafeEqual(String(machine.secret_hash), digest)) return refuse();
	if (machine.status !== 'enabled') return refuse();

	// 机器身份**由服务端从凭证解析**，工具自称的标识不作数（生成器文档 §5.4）：自称可以伪造，
	// 而对象键里的目录名要靠它，伪造就意味着一台机器能把文件写进另一台的目录。
	c.set('protocolSubject', { kind: 'token', ownerUid: '', deviceId: String(machine.id) });
	c.set('generatorMachine', { id: String(machine.id), name: String(machine.name) });
	await runSql(database, sql({ database, subjectRoles: null }).update('sms_generator_machines', { last_used_at: Date.now() }, { id: machine.id }));
	return next();
};

export default handler;
