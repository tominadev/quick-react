import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData } from '@server/modules/base/api-response.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { loadDefaultCloudStorageTarget, createCloudStorageAdapter } from '@server/modules/global/cloud/resolve.mjs';

/**
 * 生成器用的四个动作，全在一个文件里按 `?action=` 分派。
 *
 * ```text
 * config          拉短信接收地址（必须在生成文件之前调用）
 * prepare-upload  申请对象键与预签名 PUT 地址
 * commit          校验对象后按四步收敛写入令牌与文件元数据
 * abort           放弃上传，删掉临时对象
 * ```
 *
 * 凭证已在 `/api/platform.mts` 验过一次且只验一次，这里拿到的是一台确定的机器。
 *
 * 四个动作放一个文件而不是四个：路径每深一级，路由器就多一次中间件查找，而它们共享同一套
 * 前置（同一台机器、同一个对象存储用途、同一份幂等键解析）。
 */

/** 令牌文件存在哪个 Bucket——按站点与用途取默认绑定，与其它站点的对象存储走同一套配置。 */
const STORAGE_PURPOSE = 'sms-shortcut';

const textField = (value: unknown, limit: number) => (typeof value === 'string' ? value : '').slice(0, limit);
const isSha256Hex = (value: string) => /^[0-9a-f]{64}$/.test(value);

/**
 * 对象键：`shortcuts/<机器 name>/<yyyymmdd>/<毫秒时间戳>-<随机后缀>.shortcut`。
 *
 * **随机后缀不可省略。** 只用时间戳的话，并发的 prepare-upload 可能落在同一毫秒并生成相同键，
 * 后一次 PUT 会覆盖前一个对象——于是令牌记录指向装着另一个令牌的文件，领取者会拿到他人的
 * 令牌并读到他人的短信（绑定文档 §4.5）。
 *
 * 键里不含手机号，也不含 `token_sha256`。
 */
const objectKeyFor = (machineName: string) => {
	const now = new Date();
	const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
	const suffix = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `shortcuts/${machineName}/${day}/${now.getTime()}-${suffix}.shortcut`;
};

const handler: ApiHandler = async (c, next) => {
	const machine = c.get('generatorMachine');
	// 类型收窄，不是第二道验证：`generatorMachine` 只在 /api/platform/ 下存在，因此声明成可选。
	if (!machine) return apiMessage(c, 401, '生成器凭证无效或机器已停用');
	const action = c.req.query('action')?.trim();
	const database = c.get('database');

	/**
	 * **接收地址由服务端给，工具不得自行拼接。**
	 *
	 * 站点的 API 后缀是可配的（`siteConfig.apiSuffix`），拼错会生成一批永远无法工作的 Shortcut。
	 * 这个值也**刻意不放进 `.env`**：两个地址的过期风险不对称——`SMS_API_BASE` 过期时工具第一次
	 * 调用就失败，自纠且零代价；接收地址过期却是静默的，它会被烤进上百个文件、分发到用户手机，
	 * 直到某天真有短信进来才暴露，那时回收代价极高（生成器文档 §5.2）。
	 */
	if (c.req.method === 'GET' && action === 'config') {
		const suffix = c.get('techStackConfig').apiSuffix;
		const origin = new URL(c.req.url).origin;
		return apiMessageData(c, 200, '配置已下发', {
			message_receive_url: `${origin}/api/shortcut/message-receive${suffix}`,
			machine: machine.name,
		});
	}

	if (c.req.method !== 'POST') return next();
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const idempotencyToken = textField(body.idempotency_token, 64);
	if (!idempotencyToken) return apiMessage(c, 400, '缺少 idempotency_token');

	/**
	 * 对象存储**用到时才解析**，不在入口处一次性准备好。
	 *
	 * 顺序有讲究：参数校验是纯字符串判断，不查库不建连接；对象存储要查绑定、建适配器。
	 * 先解析的话，一个摘要写错格式的请求会先撞上「没配对象存储」——报的是一个与它无关的
	 * 服务端故障，调用方照着改也改不对。便宜且确定的检查排在前面。
	 */
	const storageAdapter = async () => {
		const storage = await loadDefaultCloudStorageTarget(c.get('globalDatabase'), c.get('site').siteKey, STORAGE_PURPOSE);
		return storage ? createCloudStorageAdapter(storage) : undefined;
	};
	const missingStorage = () => apiMessage(c, 503, `没有为用途 ${STORAGE_PURPOSE} 配置默认对象存储绑定`);

	/**
	 * 第一步：申请上传票据。**这一步不创建任何业务记录**，也不接收 `token_sha256`——
	 * 该阶段没有使用它的场景，提前送出只会扩大摘要的暴露面（生成器文档 §5.4）。
	 *
	 * 对象键就是票据：它由服务端生成、含 8 字节随机后缀，猜不到；commit 时校验「这个键下
	 * 确实有对象、大小对得上」，而键本身只有申请者知道。
	 */
	if (action === 'prepare-upload') {
		const fileSha256 = textField(body.file_sha256, 64);
		if (!isSha256Hex(fileSha256)) return apiMessage(c, 400, 'file_sha256 必须是 64 位小写十六进制');
		const adapter = await storageAdapter();
		if (!adapter) return missingStorage();
		const objectKey = objectKeyFor(machine.name);
		return apiMessageData(c, 200, '可以上传', {
			object_key: objectKey,
			upload_url: await adapter.createUploadUrl(objectKey, 'application/octet-stream'),
		});
	}

	/**
	 * 第三步：提交入库。**四步收敛，无事务**（绑定文档 §5.1）：
	 *
	 * 1. 以 `pending` 插入令牌，带 `idempotency_token`——重复提交在唯一约束处被挡下
	 * 2. 按 `idempotency_token` 读回 token_id
	 * 3. 插入文件元数据，`ready`
	 * 4. 令牌由 `pending` 改为 `available`
	 *
	 * 任一步之后中断都不产生有害中间态：`pending` 令牌不可领取，孤儿对象由生命周期规则清理；
	 * 重试同一 `idempotency_token` 收敛到同一结果。
	 */
	if (action === 'commit') {
		const tokenSha256 = textField(body.token_sha256, 64);
		const fileSha256 = textField(body.file_sha256, 64);
		const objectKey = textField(body.object_key, 512);
		if (!isSha256Hex(tokenSha256) || !isSha256Hex(fileSha256)) return apiMessage(c, 400, 'token_sha256 与 file_sha256 必须是 64 位小写十六进制');
		if (!objectKey.startsWith(`shortcuts/${machine.name}/`)) return apiMessage(c, 400, '对象键不属于这台机器');

		/**
		 * 同一 `idempotency_token` 重复 commit 收敛到同一结果；但**携带不同的摘要时必须拒绝**，
		 * 不得覆盖也不得返回成功——否则对象里装的是令牌 A、数据库记的是令牌 B，那个 Shortcut
		 * 永远认证不了（生成器文档 §5.5）。
		 */
		const existing = await firstSql<{ id: string; token_sha256: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_shortcut_tokens',
			columns: { id: { column: 'id', cast: 'text' }, token_sha256: 'token_sha256', status: 'status' },
			where: [{ column: 'idempotency_token', value: idempotencyToken }],
			limit: 1,
		}));
		if (existing && existing.token_sha256 !== tokenSha256) return apiMessage(c, 409, '同一 idempotency_token 已用于另一个令牌，请换一个序号重做');

		// 校验对象确实传上来了。**只能比大小,不能比摘要**：对象存储回的 ETag 对单段上传是
		// MD5，与工具算的 SHA-256 不是一回事；要真比摘要得把文件拉回来重算，代价不值。
		const adapter = await storageAdapter();
		if (!adapter) return missingStorage();
		const uploaded = (await adapter.list(objectKey, undefined, 1)).objects.find((item) => item.key === objectKey);
		if (!uploaded) return apiMessage(c, 409, '对象尚未上传完成，请先 PUT 再 commit');
		const sizeBytes = Number(body.size_bytes ?? 0);
		if (sizeBytes > 0 && Number(uploaded.size ?? 0) !== sizeBytes) return apiMessage(c, 409, '对象大小与提交的不一致');

		const builder = sql({ database, subjectRoles: null });
		if (!existing) await runSql(database, builder.ignoreInsert('sms_shortcut_tokens', ['idempotency_token'], { token_sha256: tokenSha256, status: 'pending', idempotency_token: idempotencyToken }));
		const token = existing ?? await firstSql<{ id: string; token_sha256: string; status: string }>(database, builder.select({
			table: 'sms_shortcut_tokens',
			columns: { id: { column: 'id', cast: 'text' }, token_sha256: 'token_sha256', status: 'status' },
			where: [{ column: 'idempotency_token', value: idempotencyToken }],
			limit: 1,
		}));
		if (!token) return apiMessage(c, 500, '令牌登记失败');

		await runSql(database, builder.ignoreInsert('sms_shortcut_artifacts', ['token_id', 'version'], {
			token_id: token.id,
			object_key: objectKey,
			file_sha256: fileSha256,
			size_bytes: sizeBytes,
			content_type: 'application/octet-stream',
			version: 1,
			generator_machine_id: machine.id,
			status: 'ready',
		}));
		// 只从 pending 推进：已经是 available 的重复 commit 影响 0 行，照样回成功——
		// 对调用方来说「已经入库了」和「刚入库」没有区别。
		await runSql(database, builder.update('sms_shortcut_tokens', { status: 'available' }, [
			{ column: 'id', value: token.id },
			{ column: 'status', value: 'pending' },
		]));
		return apiMessageData(c, 200, '已入库', { token_id: String(token.id) });
	}

	/** 放弃上传：删掉临时对象。没被 abort 的由对象存储生命周期规则兜底清理。 */
	if (action === 'abort') {
		const objectKey = textField(body.object_key, 512);
		if (!objectKey.startsWith(`shortcuts/${machine.name}/`)) return apiMessage(c, 400, '对象键不属于这台机器');
		const adapter = await storageAdapter();
		if (!adapter) return missingStorage();
		await adapter.deleteObject(objectKey).catch(() => undefined);
		return apiMessage(c, 200, '已放弃');
	}

	return next();
};

export default handler;
