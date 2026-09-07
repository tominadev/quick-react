import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { apiMessageData } from '@server/modules/base/api-response.mjs';
import { createCloudStorageAdapter, loadCloudStorageTargetByPurpose } from '@server/modules/global/cloud/resolve.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 我的手机：用户自己绑定的那几部。
 *
 * **绑定在这里发起**（绑定文档 §6.1 的会话路径）：用户填一个手机号，服务端建好这部手机、
 * 从公共池里领一个令牌绑上去，再回一个下载地址——用户在手机上打开它，装上那份 Shortcut，
 * 闭环就成了。反过来做不成：先装 Shortcut 再运行的话，那个令牌还是 `available`，接收接口
 * 认不出它属于哪部手机，只会回一句「这个令牌还没有绑定手机」。
 *
 * 能做的是**改名、停收、解绑**：
 *
 * - 停收（`disabled`）是临时的，关系保留，用户自己能恢复；
 * - 解绑（`revoked`）终止关系，不可恢复，只能重新走一次绑定。重新绑同一个号码之所以
 *   可行，靠的是 `number` 那条带 `deleted_at` 的唯一索引（见 sms_phones.number）。
 *
 * 都不走审批：这一层在 `/api/panel/user/` 下，`operationScope` 判成自助，立即生效。
 * 手机绑定要是排进队列，那一行会带着非 0 的 `queued_at` 对正常查询不可见，而 Shortcut
 * 发来的短信正要靠查它认领归属——排队期间短信会被拒收。
 */

/**
 * 规范化成 E.164。
 *
 * 裸 11 位数字按中国大陆号补 `+86`，`00` 开头按国际前缀转 `+`——用户填号码时很少带国家码，
 * 而这一列上有唯一索引：同一个号码写成两种形态就会绑成两部手机，短信各进各的。
 */
const normalizePhoneNumber = (value: unknown) => {
	const raw = String(value ?? '').replace(/[\s()\u2010-\u2015-]/g, '');
	const candidate = raw.startsWith('+') ? raw
		: /^1\d{10}$/.test(raw) ? `+86${raw}`
			: raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
	return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : '';
};

const STATUS_OPTIONS = [
	{ value: 'enabled', text: '正常接收', color: 'green' },
	{ value: 'disabled', text: '已停收', color: 'gold' },
	{ value: 'revoked', text: '已解绑', color: 'red' },
];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	// 手机号是本表的名字列（NAME_COLUMNS 里登记成 number）。它由绑定流程写入，改不得：
	// 改掉就成了「把这部手机的短信记到另一个号上」。
	{ dataIndex: 'number', title: '手机号', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'client_title', title: '所属项目', emptyText: '未挂项目', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'title', title: '设备名称', component: 'textbox' as const, emptyText: '未命名', placeholder: '给自己看的名字，如「备用机」' },
	{ dataIndex: 'status', title: '状态', component: 'select' as const, options: STATUS_OPTIONS,
		// 解绑不可逆，选项里给出来但配了确认文案；下拉里没有别的路径能改回 revoked。
		placeholder: '停收可以自行恢复；解绑不可恢复' },
	{ dataIndex: 'bound_at', title: '绑定时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'revoked_at', title: '解绑时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '未解绑', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_phones', rowKey: 'id' };

const listColumns = {
	id: { column: 'p.id', cast: 'text' as const }, number: 'p.number', title: 'p.title', status: 'p.status',
	client_title: 'c.title', bound_at: 'p.bound_at', revoked_at: 'p.revoked_at', created_at: 'p.created_at',
} as const;
const listJoins = [{ type: 'LEFT' as const, table: 'sms_integration_clients', alias: 'c', left: 'c.id', right: 'p.integration_client_id' }];

const publicPhone = (row: Record<string, unknown>) => ({
	id: row.id, number: row.number, title: row.title || null, client_title: row.client_title ?? null, status: row.status,
	bound_at: Number(row.bound_at ?? 0) || null,
	revoked_at: Number(row.revoked_at ?? 0) || null,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	/**
	 * **只看自己的。** 公共层的归属判定已经会按 `owner_uid` 收敛，这里再写一次条件是
	 * 因为这一页的语义就是「我的手机」——判定将来若放宽（例如让分站管理员代看），
	 * 这一页也不该跟着放宽。两道锁不冲突，少一道才危险。
	 */
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	/** 选中的项目必须是自己注册的：带别人的接入方 id，等于把手机挂到别人的项目下。 */
	const ownedClient = async (value: unknown) => {
		const clientId = String(value ?? '').trim();
		// 空与 '0' 都念作「不属于任何项目」，落库统一写 0（见 prisma 那一列的注释）。
		if (!clientId || clientId === '0') return { value: '0' };
		const row = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'id', value: clientId }, ownerScope('owner_uid', currentUser.id)], limit: 1,
		}));
		return row ? { value: String(row.id) } : { error: '选中的项目不存在，或者不属于你' };
	};
	const mine = (column = 'owner_uid') => ownerScope(column, currentUser.id);

	/**
	 * 绑定一部手机（§6.1）。
	 *
	 * 归属取**当前会话**的账号，请求体里带什么用户编号都不作数——那是别人的数据。
	 */
	if (!params.id && c.req.method === 'POST' && c.req.query('action') === 'bind') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const number = normalizePhoneNumber(body.number);
		if (!number) return apiMessage(c, 400, '手机号格式不对：请填国际格式（如 +8613800138000），或直接填 11 位手机号');
		const title = String(body.title ?? '').trim().slice(0, 64);
		const client = await ownedClient(body.integration_client_id);
		if (client.error) return apiMessage(c, 400, client.error);
		/**
		 * 同一个号码重复绑定要幂等（§4.3）：直接告诉他已经绑过，不再建一行。
		 * 解绑过的（`revoked`）不算——那条关系已经终止，重新绑定正是要走这一遍。
		 */
		/**
		 * 幂等只看**自己在这个项目下**有没有绑过（§4.3）。别人绑过同一个号不算冲突——
		 * 手机往往是客户的，两家服务商服务同一位客户是常事，各自装各自的快捷指令。
		 */
		const existing = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, status: 'status' },
			where: [{ column: 'number', value: number }, { column: 'integration_client_id', value: client.value }, mine()], limit: 1,
		}));
		if (existing && existing.status !== 'revoked') return apiMessage(c, 409, '这个号码你在这个项目下已经绑定过了，在下面的列表里');

		/**
		 * **先领令牌，再建手机。** 反过来的话，池子空了会留下一部绑不上令牌的手机——它在
		 * 列表里看着正常，却永远收不到短信，而用户唯一能做的是把它删掉重来。
		 *
		 * 领取用条件更新（§5.2）：`WHERE id = ? AND status = 'available'`，影响 0 行就说明
		 * 被别人抢先了，换下一个。取十个候选够了——真同时有十个人在领，池子本来也该补货。
		 */
		const candidates = await allSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_shortcut_tokens', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'status', value: 'available' }], orderBy: [{ column: 'id' }], limit: 10,
		}));
		if (!candidates.length) return apiMessage(c, 503, '令牌池空了，暂时不能绑定新手机。请联系管理员补充。');

		// 先查后插之间仍可能被别人抢先（无事务），撞上了照样翻成人话，不让裸 UNIQUE 冒出去。
		try {
			await runOperationSql(c, database, sql({ database }).insert('sms_phones', { number, title, status: 'enabled', bound_at: Date.now(), integration_client_id: client.value }));
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '这个号码刚在这个项目下被绑上了，刷新看看');
		}
		const phone = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'number', value: number }, { column: 'integration_client_id', value: client.value }, mine()], limit: 1,
		}));
		if (!phone) return apiMessage(c, 500, '手机记录创建后读不回来，请重试');

		/**
		 * 语句用系统上下文构造（`subjectRoles: null`）：池子里的令牌 `owner_uid` 是空的，
		 * 按当前用户的可见性去更新一行也匹配不上。但**写入仍然走 `runOperation`**——领取
		 * 是人工触发的业务写入，照样要留痕；直接 `runSql` 会被公共层拦下，那道守卫是对的。
		 */
		let claimed: string | undefined;
		for (const candidate of candidates) {
			const result = await runOperationSql(c, database, sql({ database, subjectRoles: null }).update('sms_shortcut_tokens',
				{ owner_uid: currentUser.id, phone_id: phone.id, status: 'bound' },
				[{ column: 'id', value: candidate.id }, { column: 'status', value: 'available' }]));
			if (Number(result?.meta?.changes ?? 0) > 0) { claimed = candidate.id; break; }
		}
		if (!claimed) return apiMessage(c, 503, '刚好有别人同时在领取，请再试一次');

		/**
		 * 回一个下载地址，用户在**手机上**打开它装 Shortcut。
		 *
		 * 地址短期有效，文件始终在私有 Bucket 里——`.shortcut` 里就装着那个令牌，
		 * 能下载就等于能收这部手机的短信。
		 */
		const artifact = await firstSql<{ object_key: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_shortcut_artifacts', columns: { object_key: 'object_key' },
			where: [{ column: 'token_id', value: claimed }, { column: 'status', value: 'ready' }],
			orderBy: [{ column: 'version', direction: 'DESC' }], limit: 1,
		}));
		const storage = artifact ? await loadCloudStorageTargetByPurpose(c.get('globalDatabase'), c.get('site').siteKey, 'sms-shortcut') : undefined;
		/**
		 * 下载时用一个看得懂的文件名。对象键里是时间戳和随机后缀，直接下载拿到的是
		 * `1788721695130-c6698636918564bf.shortcut`——发给客户之后，他在「文件」里根本
		 * 认不出这是什么、更认不出装哪一个（同一个人可能同时收到好几个项目的）。
		 */
		const clientTitle = client.value === '0' ? '' : (await firstSql<{ title: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { title: 'title' }, where: [{ column: 'id', value: client.value }], limit: 1,
		})))?.title ?? '';
		const filename = `${clientTitle || '短信转发'}-${number.slice(-4)}.shortcut`;
		const downloadUrl = storage && artifact ? await createCloudStorageAdapter(storage).createDownloadUrl(String(artifact.object_key), { filename }).catch(() => undefined) : undefined;
		return apiMessageData(c, 200,
			downloadUrl
				? `${number} 已绑定。请在**手机上**打开下面的地址下载并添加这个快捷指令，添加后运行一次即可开始转发短信：\n\n${downloadUrl}\n\n地址 15 分钟内有效，过期可以在列表里重新获取。`
				: `${number} 已绑定，但取回快捷指令文件失败——请联系管理员检查 sms-shortcut 用途的对象存储绑定。`,
			{ number, download_url: downloadUrl ?? null },
			{ component: 'modal', showIcon: true, title: '绑定成功' });
	}

	if (c.req.method === 'GET' && !params.id) {
		const clients = (await allSql<{ id: string; name: string; title: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' }, name: 'name', title: 'title' },
			where: [ownerScope('owner_uid', currentUser.id)], orderBy: [{ column: 'id' }],
		}))).map((row) => ({ value: String(row.id), text: `${row.title}（${row.name}）` }));
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_phones', alias: 'p', columns: listColumns, joins: listJoins, where: [mine('p.owner_uid')],
			sort: tableSort(c), orderBy: [{ column: 'p.id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 「新增」换成「绑定手机」：直接插一行手机号是没有意义的，那部手机没有令牌，
				// 一条短信也进不来。绑定要连着领令牌、给下载地址一起完成。
				toolbar: [{ key: 'bind', label: '绑定手机', form: { columns: [
					{ dataIndex: 'number', title: '手机号', component: 'textbox' as const, placeholder: '如 +8613800138000，或直接填 11 位', rules: [{ required: true, message: '请输入手机号' }] },
					{ dataIndex: 'title', title: '设备名称', component: 'textbox' as const, placeholder: '给自己看的名字，如「备用机」' },
					// 同一个号可以在不同项目下各绑一次，各自领一份快捷指令——手机往往是客户的，
					// 而同一位客户可能同时用着你的好几个项目。
					{ dataIndex: 'integration_client_id', title: '所属项目', component: 'select' as const, options: clients, nullable: true, placeholder: '不选就是不挂在任何项目下' },
				] } }],
				row: [{ key: 'edit', label: '编辑' }],
			} },
			columns, dataSource: rows.map(publicPhone), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_phones', alias: 'p', columns: listColumns, joins: listJoins, where: [{ column: 'p.id', value: params.id }, mine('p.owner_uid')],
		}));
		return row ? apiResponse(c, 200, publicPhone(row)) : apiMessage(c, 404, '手机不存在');
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const row = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_phones', columns: { id: { column: 'id', cast: 'text' }, status: 'status' },
			where: [{ column: 'id', value: params.id }, mine()],
		}));
		if (!row) return apiMessage(c, 404, '手机不存在');
		if (row.status === 'revoked') return apiMessage(c, 409, '这部手机已经解绑，重新绑定请在手机上再走一次 Shortcut');
		const changed = getChangedFields(body, ['title', 'status']);
		const values: Record<string, unknown> = {};
		if (changed.has('title')) values.title = String(body.title ?? '').trim().slice(0, 64);
		if (changed.has('status')) {
			const status = String(body.status ?? '');
			if (!['enabled', 'disabled', 'revoked'].includes(status)) return apiMessage(c, 400, '状态只能是正常接收、已停收或已解绑');
			values.status = status;
			// 解绑时间由服务端写，不收前端的值：它是「什么时候终止的」这一事实，不是一个可填字段。
			if (status === 'revoked') values.revoked_at = Date.now();
		}
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		// 带上原状态做条件：两个标签页同时改同一部手机，只有一个会真的落到行上。
		await runOperation(c, database, [sql({ database }).update('sms_phones', values, [
			{ column: 'id', value: params.id }, { column: 'status', value: row.status }, mine(),
		])]);
		return apiMessage(c, 200, values.status === 'revoked' ? '已解绑，这部手机不再接收短信' : '已保存');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的手机');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_phones', [{ column: 'id', value: id }, mine()])));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
