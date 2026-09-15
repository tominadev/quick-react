import type { DatabaseAdapter } from '@server/database/index.mjs';
import { KEY_PATTERN, allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { createCloudStorageAdapter, loadCloudStorageTargetByPurpose } from '@server/modules/global/cloud/resolve.mjs';

/**
 * 手机绑定的共用实现。**两条路径走同一段代码**：用户在控制台自己绑（会话路径 §6.1），
 * 接入方用票据代绑（票据路径 §6.2）。
 *
 * 各写一遍的话，「先领令牌再建手机」「重复绑定要幂等」「号码怎么规范化」这些规则会在
 * 两处漂移，而漂移的表现是「从控制台绑好用、从接口绑不好用」——同一个用户、同一个号码。
 *
 * **去重的落点因路径而不同**（绑定文档 §4.3）：
 *
 * - 票据路径传了 `key`：去重靠这个 key（应用层，见 `bindByKey`）。`number` 上**没有**唯一
 *   索引，同一个号码在同一个接入方名下可以绑出好几行——接入方传不同的 key 就是不同的绑定。
 * - 没传 `key`（票据路径不传，或控制台会话路径——它压根没有 key 的概念）：去重靠
 *   `(账号, 项目, number)`，这段代码在原来就有，改动前后行为不变，只是没有数据库唯一
 *   索引兜底了，靠先查后插——人在控制台点两下「绑定」不该绑出两部一样的手机。
 */

/**
 * 规范化成 E.164。
 *
 * 裸 11 位数字按中国大陆号补 `+86`，`00` 开头按国际前缀转 `+`——用户填号码时很少带国家码。
 */
export const normalizePhoneNumber = (value: unknown) => {
	const raw = String(value ?? '').replace(/[\s()‐-―-]/g, '');
	const candidate = raw.startsWith('+') ? raw
		: /^1\d{10}$/.test(raw) ? `+86${raw}`
			: raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
	return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : '';
};

/**
 * 接入方自己的引用串，不透明、不解析，原样存、原样在推送时带回去（同 Stripe 的
 * `client_reference_id`）——接入方不一定按手机号存自己的客户，短信到达时单靠一个手机号，
 * 未必能对回是哪个客户。**不参与任何唯一性判断**，去重靠 `key`（见上）。
 */
export const normalizeClientRef = (value: unknown) => String(value ?? '').trim().slice(0, 128);

export type BindOutcome =
	| { ok: false; status: number; message: string }
	/**
	 * `alreadyBound` 为真表示这次没新建手机记录。`reissued` 为真表示那部手机原来的快捷指令
	 * 已经失效（令牌被删或被撤销），这次换发了一份新的——手机上装着的旧的那份不能再用了。
	 */
	| { ok: true; alreadyBound: boolean; reissued: boolean; number: string; phoneId: string; clientRef: string; downloadUrl?: string };

type BindWrite = (statement: ReturnType<ReturnType<typeof sql>['insert']>) => Promise<{ meta?: { changes?: number } } | undefined>;

type BindOptions = {
	database: DatabaseAdapter;
	globalDatabase: DatabaseAdapter;
	siteKey: string;
	ownerUid: string;
	clientId: string;
	number: string;
	title: string;
	clientRef: string;
	/**
	 * **接入方自己指定这一行的 `key`，不传就照常自动生成雪花号。** 这张表是本项目里除
	 * `global_sites` 外唯一允许调用方指定 `key` 的表（详见 prisma/sms.prisma 的注释）。
	 * 传了就走 `bindByKey`：同一个 key 命中同一行、直接给原来那份快捷指令；同一个 key
	 * 被**别的**接入方占用则拒绝。控制台会话路径永远不传。
	 */
	key?: string;
	/** 执行一条写入。会话路径走 runOperation，票据路径走绑好归属的 runSql。 */
	runWrite: BindWrite;
};

type BindContext = { database: DatabaseAdapter; globalDatabase: DatabaseAdapter; siteKey: string; clientId: string; number: string };

/** 池子里能领的令牌。取十个候选够了——真同时有十个人在领，池子本来也该补货。 */
const poolCandidates = (database: DatabaseAdapter) => allSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
	table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' } },
	where: [{ column: 'status', value: 'available' }], orderBy: [{ column: 'id' }], limit: 10,
}));

/** 这部手机现在有没有一个能用的令牌。被删的默认查不到，被撤销的状态不是 bound，都算没有。 */
const hasLiveToken = async (database: DatabaseAdapter, phoneId: string) => Boolean(await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
	table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' } },
	where: [{ column: 'phone_id', value: phoneId }, { column: 'status', value: 'bound' }], limit: 1,
})));

/**
 * 从候选里领一个挂到这部手机上。
 *
 * 领取用条件更新（§5.2）：`WHERE id = ? AND status = 'available'`，影响 0 行就说明被别人
 * 抢先了，换下一个。
 */
const claimToken = async (options: { database: DatabaseAdapter; ownerUid: string; runWrite: BindWrite }, candidates: Array<{ id: string }>, phoneId: string) => {
	const { database } = options;
	for (const candidate of candidates) {
		const result = await options.runWrite(sql({ database, subjectRoles: null }).update('sms_shortcut_tokens',
			{ owner_uid: options.ownerUid, phone_id: phoneId, status: 'bound' },
			[{ column: 'id', value: candidate.id }, { column: 'status', value: 'available' }]) as never);
		if (Number(result?.meta?.changes ?? 0) > 0) return candidate.id;
	}
	return undefined;
};

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
 * **命中一条已存在、且确认归属调用方的行，给出结果。** 票据路径的 `key` 命中、以及会话
 * 路径按号码命中，都走到这里——两处不能各写一遍，理由见文件头。
 *
 * 行为两支：
 * - `status === 'revoked'`：**复用这一行**，改回 `enabled`，先作废它名下仍是 `bound` 的
 *   旧令牌（否则手机一恢复，旧快捷指令跟着复活），再领一把新的。算作「重新绑定成功」。
 * - 其余状态：号有没有活着的令牌。有就只重取一次下载地址；没有（被删或被撤销，例如
 *   管理员清空过令牌池）就**就地换发**——幂等说的是「保证有一份能用的快捷指令」，不是
 *   「记录在就算完」。
 *
 * `number`/`title` 顺带同步成这次调用带来的值：key 驱动的绑定里，同一个 key 后续换了
 * 号码（例如客户换了手机）也该跟着更新；号码驱动的那一支这两个值本就没变，多写一次无害。
 */
const resumeExisting = async (options: BindOptions, context: BindContext, phoneId: string, status: string): Promise<BindOutcome> => {
	const { database, ownerUid, number, title, clientRef } = options;
	const mine = () => ownerScope('owner_uid', ownerUid);

	if (status === 'revoked') {
		const candidates = await poolCandidates(database);
		if (!candidates.length) return { ok: false, status: 503, message: '令牌池空了，暂时不能绑定新手机。请联系管理员补充。' };
		await options.runWrite(sql({ database, subjectRoles: null }).update('sms_shortcut_tokens', { status: 'revoked' },
			[{ column: 'phone_id', value: phoneId }, { column: 'status', value: 'bound' }]) as never);
		// 带着原状态做条件：两个请求同时重绑同一行，只有一个会真的把它改回来。
		const revived = await options.runWrite(sql({ database }).update('sms_phones',
			{ status: 'enabled', bound_at: Date.now(), number, revoked_at: null, ...(title ? { title } : {}) },
			[{ column: 'id', value: phoneId }, { column: 'status', value: 'revoked' }, mine()]) as never);
		if (Number(revived?.meta?.changes ?? 0) === 0) return { ok: false, status: 409, message: '这一行刚被重新绑定，请刷新确认' };
		if (!await claimToken(options, candidates, phoneId)) return { ok: false, status: 503, message: '刚好有别人同时在领取，请再试一次' };
		return { ok: true, alreadyBound: false, reissued: false, number, phoneId, clientRef, downloadUrl: await downloadUrlForPhone(context, phoneId) };
	}

	if (!await hasLiveToken(database, phoneId)) {
		const candidates = await poolCandidates(database);
		if (!candidates.length) return { ok: false, status: 503, message: '原来的快捷指令已经失效，但令牌池空了，暂时换发不了。请联系管理员补充。' };
		if (!await claimToken(options, candidates, phoneId)) return { ok: false, status: 503, message: '刚好有别人同时在领取，请再试一次' };
		await options.runWrite(sql({ database }).update('sms_phones', { number, ...(title ? { title } : {}) }, [{ column: 'id', value: phoneId }, mine()]) as never);
		return { ok: true, alreadyBound: true, reissued: true, number, phoneId, clientRef, downloadUrl: await downloadUrlForPhone(context, phoneId) };
	}
	await options.runWrite(sql({ database }).update('sms_phones', { number, ...(title ? { title } : {}) }, [{ column: 'id', value: phoneId }, mine()]) as never);
	// 令牌还在：不新建关系，但**要把下载地址再给一次**——理由见 downloadUrlForPhone。
	return { ok: true, alreadyBound: true, reissued: false, number, phoneId, clientRef, downloadUrl: await downloadUrlForPhone(context, phoneId) };
};

/**
 * 票据路径传了 `key` 时走这一支。
 *
 * `key` 的唯一索引（`@@unique([key])`）**不带 `deleted_at`**——软删过的行照样占着这个 key，
 * 因此查找与竞态兜底都要用 `deleted: 'all'`，不能只看活跃行；否则一个已删除的 key 会在
 * 应用层查不到、却在真插入时撞上裸 UNIQUE。
 */
const bindByKey = async (options: BindOptions, context: BindContext, key: string): Promise<BindOutcome> => {
	const { database, ownerUid, clientId, number, title, clientRef } = options;
	if (!KEY_PATTERN.test(key)) return { ok: false, status: 400, message: '标识格式不对：只能是英文字母、数字、下划线和连字符，最长 36 位' };

	const lookup = () => firstSql<{ id: string; owner_uid: string | null; integration_client_id: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones',
		columns: { id: { column: 'id', cast: 'text' }, owner_uid: { column: 'owner_uid', cast: 'text' }, integration_client_id: { column: 'integration_client_id', cast: 'text' }, status: 'status' },
		where: [{ column: 'key', value: key }], deleted: 'all', limit: 1,
	}));
	/**
	 * **同一个 key，只看是不是同一个接入方**（账号 + 项目都对上）。是——反正就是他的，
	 * 直接把原来那份快捷指令给他，不提示重复；不是——这个 key 被别的接入方占用了，拒绝，
	 * 且不透露占用者的任何信息（谁在用、什么状态），只说「已被占用」。
	 */
	const own = (row: { owner_uid: string | null; integration_client_id: string }) => String(row.owner_uid ?? '') === String(ownerUid) && String(row.integration_client_id) === String(clientId);

	const found = await lookup();
	if (found) {
		if (!own(found)) return { ok: false, status: 409, message: '这个标识已经被占用，换一个' };
		return resumeExisting(options, context, String(found.id), found.status);
	}

	const candidates = await poolCandidates(database);
	if (!candidates.length) return { ok: false, status: 503, message: '令牌池空了，暂时不能绑定新手机。请联系管理员补充。' };

	try {
		await options.runWrite(sql({ database }).insert('sms_phones', { key, number, title, status: 'enabled', bound_at: Date.now(), integration_client_id: clientId, client_ref: clientRef }));
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
		// 竞态：两个请求同时用了同一个新 key。按同一套规则再判一次。
		const raced = await lookup();
		if (!raced) return { ok: false, status: 409, message: '这个标识刚被占用，请刷新确认' };
		if (!own(raced)) return { ok: false, status: 409, message: '这个标识已经被占用，换一个' };
		return resumeExisting(options, context, String(raced.id), raced.status);
	}
	const phone = await lookup();
	if (!phone) return { ok: false, status: 500, message: '手机记录创建后读不回来，请重试' };

	const claimed = await claimToken(options, candidates, String(phone.id));
	if (!claimed) return { ok: false, status: 503, message: '刚好有别人同时在领取，请再试一次' };
	return { ok: true, alreadyBound: false, reissued: false, number, phoneId: String(phone.id), clientRef, downloadUrl: await downloadUrlForPhone(context, String(phone.id)) };
};

/**
 * 没有 `key` 时走这一支——控制台会话路径固定走这里；票据路径不传 `key` 时也是这里。
 *
 * 去重靠**应用层**查 `(账号, 项目, number)`：这一列上不再有数据库唯一索引兜底（详见
 * prisma/sms.prisma 的注释），先查后插存在竞态窗口，用插入失败时的 `isUniqueViolation`
 * 兜底纯属巧合——那条索引现在已经不存在了，所以这里改成插入前查、插入后再查一次核对，
 * 两个请求同时绑同一个号，极端情况下确实可能各建一行；这与「控制台点两下不该绑出两部
 * 一样的手机」这个目标在绝大多数场景下仍然成立，只是不再有数据库兜底最后一道防线。
 */
const bindByNumber = async (options: BindOptions, context: BindContext): Promise<BindOutcome> => {
	const { database, ownerUid, clientId, number, title, clientRef } = options;
	const mine = () => ownerScope('owner_uid', ownerUid);
	const scope = [{ column: 'number', value: number }, { column: 'integration_client_id', value: clientId }, mine()];

	const existing = await firstSql<{ id: string; status: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: scope, limit: 1,
	}));
	if (existing) return resumeExisting(options, context, String(existing.id), existing.status);

	const candidates = await poolCandidates(database);
	if (!candidates.length) return { ok: false, status: 503, message: '令牌池空了，暂时不能绑定新手机。请联系管理员补充。' };

	await options.runWrite(sql({ database }).insert('sms_phones', { number, title, status: 'enabled', bound_at: Date.now(), integration_client_id: clientId, client_ref: clientRef }));
	// 没有唯一索引兜底竞态：再查一次，取最新（大概率就是刚插的那条；同时插入时取哪一条
	// 都行，反正对调用方来说「有一部这个号码的手机」这件事是成立的）。
	const phone = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
		table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' } }, where: scope, orderBy: [{ column: 'id', direction: 'DESC' }], limit: 1,
	}));
	if (!phone) return { ok: false, status: 500, message: '手机记录创建后读不回来，请重试' };

	const claimed = await claimToken(options, candidates, String(phone.id));
	if (!claimed) return { ok: false, status: 503, message: '刚好有别人同时在领取，请再试一次' };
	/**
	 * 回一个下载地址，用户在**手机上**打开它装 Shortcut。地址短期有效，文件始终在私有
	 * Bucket 里——`.shortcut` 里就装着那个令牌，能下载就等于能收这部手机的短信。
	 */
	return { ok: true, alreadyBound: false, reissued: false, number, phoneId: String(phone.id), clientRef, downloadUrl: await downloadUrlForPhone(context, String(phone.id)) };
};

/** 建手机、领令牌、取回下载地址。分派到 `bindByKey` 还是 `bindByNumber`，见文件头。 */
export const bindPhone = async (options: BindOptions): Promise<BindOutcome> => {
	const context: BindContext = { database: options.database, globalDatabase: options.globalDatabase, siteKey: options.siteKey, clientId: options.clientId, number: options.number };
	return options.key ? bindByKey(options, context, options.key) : bindByNumber(options, context);
};
