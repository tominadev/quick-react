import type { DatabaseAdapter } from '@server/database/index.mjs';
import { allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { createCloudStorageAdapter, loadCloudStorageTargetByPurpose } from '@server/modules/global/cloud/resolve.mjs';

/**
 * 手机绑定的共用实现。**两条路径走同一段代码**：用户在控制台自己绑（会话路径 §6.1），
 * 接入方用票据代绑（票据路径 §6.2）。
 *
 * 各写一遍的话，「先领令牌再建手机」「重复绑定要幂等」「号码怎么规范化」这些规则会在
 * 两处漂移，而漂移的表现是「从控制台绑好用、从接口绑不好用」——同一个用户、同一个号码。
 */

/**
 * 规范化成 E.164。
 *
 * 裸 11 位数字按中国大陆号补 `+86`，`00` 开头按国际前缀转 `+`——用户填号码时很少带国家码，
 * 而这一列上有唯一索引：同一个号码写成两种形态就会绑成两部手机，短信各进各的。
 */
export const normalizePhoneNumber = (value: unknown) => {
	const raw = String(value ?? '').replace(/[\s()‐-―-]/g, '');
	const candidate = raw.startsWith('+') ? raw
		: /^1\d{10}$/.test(raw) ? `+86${raw}`
			: raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
	return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : '';
};

export type BindOutcome =
	| { ok: false; status: number; message: string }
	/** `alreadyBound` 为真表示这次没新建关系，只是把现有那部手机的下载地址又取了一遍。 */
	| { ok: true; alreadyBound: boolean; number: string; phoneId: string; downloadUrl?: string };

type BindContext = { database: DatabaseAdapter; globalDatabase: DatabaseAdapter; siteKey: string; clientId: string; number: string };

/**
 * 取这部手机当前令牌的短期下载地址。
 *
 * 重复绑定要走这一条：接入方把链接发给客户、客户没点、15 分钟过了——这时唯一能救场的
 * 就是**再要一次地址**。如果重复绑定只回一句「已经绑定过了」，那部手机就卡死在「登记了
 * 但装不上」的状态，用户能做的只有解绑重来。
 */
const downloadUrlForPhone = async (context: BindContext, phoneId: string) => {
	const { database } = context;
	const token = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'phone_id', value: phoneId }, { column: 'status', value: 'bound' }],
		orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
	}));
	if (!token) return undefined;
	const artifact = await firstSql<{ object_key: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_shortcut_artifacts', columns: { object_key: 'object_key' },
		where: [{ column: 'token_id', value: token.id }, { column: 'status', value: 'ready' }],
		orderBy: [{ column: 'version', direction: 'DESC' }], limit: 1,
	}));
	if (!artifact) return undefined;
	const storage = await loadCloudStorageTargetByPurpose(context.globalDatabase, context.siteKey, 'sms-shortcut');
	if (!storage) return undefined;
	// 文件名要看得懂：对象键里是时间戳和随机后缀，发给客户之后他在「文件」里认不出是什么。
	const clientTitle = context.clientId === '0' ? '' : (await firstSql<{ title: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_integration_clients', columns: { title: 'title' }, where: [{ column: 'id', value: context.clientId }], limit: 1,
	})))?.title ?? '';
	const filename = `${clientTitle || '短信转发'}-${context.number.slice(-4)}.shortcut`;
	return await createCloudStorageAdapter(storage).createDownloadUrl(String(artifact.object_key), { filename }).catch(() => undefined);
};

/**
 * 建手机、领令牌、取回下载地址。
 *
 * `runWrite` 由调用方给：会话路径要走操作层（留痕、审批判定按路径来），票据路径没有本站
 * 会话、要显式绑定归属上下文。两条路径的写入语义不同，但**顺序与判定完全一致**。
 */
export const bindPhone = async (options: {
	database: DatabaseAdapter;
	globalDatabase: DatabaseAdapter;
	siteKey: string;
	ownerUid: string;
	clientId: string;
	number: string;
	title: string;
	/** 执行一条写入。会话路径走 runOperation，票据路径走绑好归属的 runSql。 */
	runWrite: (statement: ReturnType<ReturnType<typeof sql>['insert']>) => Promise<{ meta?: { changes?: number } } | undefined>;
}): Promise<BindOutcome> => {
	const { database, ownerUid, clientId, number, title } = options;
	const mine = () => ownerScope('owner_uid', ownerUid);
	const context: BindContext = { database, globalDatabase: options.globalDatabase, siteKey: options.siteKey, clientId, number };

	/**
	 * 幂等只看**这个人在这个项目下**有没有绑过（§4.3）。别人绑过同一个号不算冲突——
	 * 手机往往是客户的，两家服务商服务同一位客户是常事，各自装各自的快捷指令。
	 * 解绑过的（`revoked`）不算：那条关系已经终止，重新绑定正是要走这一遍。
	 */
	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, status: 'status' },
		where: [{ column: 'number', value: number }, { column: 'integration_client_id', value: clientId }, mine()], limit: 1,
	}));
	if (existing && existing.status !== 'revoked') {
		// 幂等（§7.2）：不新建关系，但**要把下载地址再给一次**——理由见 downloadUrlForPhone。
		return { ok: true, alreadyBound: true, number, phoneId: String(existing.id), downloadUrl: await downloadUrlForPhone(context, String(existing.id)) };
	}

	/**
	 * **先领令牌，再建手机。** 反过来的话，池子空了会留下一部绑不上令牌的手机——它在列表里
	 * 看着正常，却永远收不到短信，而用户唯一能做的是把它删掉重来。
	 */
	const candidates = await allSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'status', value: 'available' }], orderBy: [{ column: 'id' }], limit: 10,
	}));
	if (!candidates.length) return { ok: false, status: 503, message: '令牌池空了，暂时不能绑定新手机。请联系管理员补充。' };

	try {
		await options.runWrite(sql({ database }).insert('sms_phones', { number, title, status: 'enabled', bound_at: Date.now(), integration_client_id: clientId }));
	} catch (error) {
		// 先查后插之间仍可能被抢先（无事务）。撞上唯一索引说明**关系已经存在**，那就是幂等的
		// 那一支——按已绑定处理，不让裸 UNIQUE 冒出去，也不回一个用户没法处理的 409。
		if (!isUniqueViolation(error)) throw error;
		const raced = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'number', value: number }, { column: 'integration_client_id', value: clientId }, mine()], limit: 1,
		}));
		if (!raced) return { ok: false, status: 409, message: '这个号码刚被占用，请刷新确认' };
		return { ok: true, alreadyBound: true, number, phoneId: String(raced.id), downloadUrl: await downloadUrlForPhone(context, String(raced.id)) };
	}
	const phone = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' } },
		where: [{ column: 'number', value: number }, { column: 'integration_client_id', value: clientId }, mine()], limit: 1,
	}));
	if (!phone) return { ok: false, status: 500, message: '手机记录创建后读不回来，请重试' };

	/**
	 * 领取用条件更新（§5.2）：`WHERE id = ? AND status = 'available'`，影响 0 行就说明被
	 * 别人抢先了，换下一个。取十个候选够了——真同时有十个人在领，池子本来也该补货。
	 */
	let claimed: string | undefined;
	for (const candidate of candidates) {
		const result = await options.runWrite(sql({ database, subjectRoles: null }).update('sms_shortcut_tokens',
			{ owner_uid: ownerUid, phone_id: phone.id, status: 'bound' },
			[{ column: 'id', value: candidate.id }, { column: 'status', value: 'available' }]) as never);
		if (Number(result?.meta?.changes ?? 0) > 0) { claimed = candidate.id; break; }
	}
	if (!claimed) return { ok: false, status: 503, message: '刚好有别人同时在领取，请再试一次' };

	/**
	 * 回一个下载地址，用户在**手机上**打开它装 Shortcut。地址短期有效，文件始终在私有
	 * Bucket 里——`.shortcut` 里就装着那个令牌，能下载就等于能收这部手机的短信。
	 */
	return { ok: true, alreadyBound: false, number, phoneId: String(phone.id), downloadUrl: await downloadUrlForPhone(context, String(phone.id)) };
};
