import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, ownerScope, sql } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { apiMessageData } from '@server/modules/base/api-response.mjs';
import { bindPhone, normalizePhoneNumber } from '@server/modules/sms/binding.mjs';
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
 * 能做的是**改名、停收、解绑、删除**：
 *
 * - 停收（`disabled`）是临时的，关系保留，用户自己能恢复；
 * - 解绑（`revoked`）终止关系，在这一页改不回来，只能重新走一次绑定。解绑**不是删除**，
 *   那一行仍占着唯一索引，所以重新绑定是复用这一行、换一个新令牌（见 modules/sms/binding.mts），
 *   而不是新建一行；
 * - 删除是软删，快捷指令即刻停用。唯一索引带 `deleted_at`，同一个号码可以马上重新绑。
 *
 * 都不走审批：这一层在 `/api/panel/user/` 下，`operationScope` 判成自助，立即生效。
 * 手机绑定要是排进队列，那一行会带着非 0 的 `queued_at` 对正常查询不可见，而 Shortcut
 * 发来的短信正要靠查它认领归属——排队期间短信会被拒收。
 */

const PUSH_HINT_OPTIONS = [
	{ value: 'configured', text: '已配置', color: 'green' },
	{ value: 'none', text: '未配置：短信只存在平台上', color: 'gold' },
];

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
	{ dataIndex: 'revoked_at', title: '解绑时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '未解绑', form: { create: false as const, edit: false as const } },
	/**
	 * **「通不通」与「有没有短信」分两列**：手机的主人手动运行一次快捷指令只刷新前一格。
	 * 合成一格的话，点完测试看到时间在动，分不清是自己点的还是刚好来了条短信。
	 */
	{ dataIndex: 'last_check_at', title: '最近自检', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'last_message_at', title: '最近收到短信', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } },
	/**
	 * 短信会不会转发到你的服务器。这件事手机上的回执**不说**——读回执的是手机的主人，他不
	 * 知道什么是推送地址。但平台用户要知道：没配的话短信只躺在平台上，而在不发真短信的
	 * 前提下，这是唯一能提前发现的地方。
	 */
	{ dataIndex: 'push_hint', title: '转发到服务器', options: PUSH_HINT_OPTIONS, form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_phones', rowKey: 'id' };

const listColumns = {
	id: { column: 'p.id', cast: 'text' as const }, number: 'p.number', title: 'p.title', status: 'p.status',
	client_title: 'c.title', bound_at: 'p.bound_at', revoked_at: 'p.revoked_at', created_at: 'p.created_at',
	integration_client_id: { column: 'p.integration_client_id', cast: 'text' as const },
	last_check_at: 'p.last_check_at', last_message_at: 't.last_used_at',
} as const;
/**
 * 「最近收到短信」取令牌的 `last_used_at`：接收接口只在真短信入账时刷新它，自检不碰。
 *
 * **只连 `bound` 的那个。** 原令牌被删或被撤销后重绑会换发一个新的（modules/sms/binding.mts），
 * 于是一部手机可能挂着新旧好几个令牌；不限定的话列表里同一部手机会出现好几行。被删的
 * 连接层自己会排除，被撤销的不会，所以条件要写明。
 */
const listJoins = [
	{ type: 'LEFT' as const, table: 'sms_integration_clients', alias: 'c', left: 'c.id', right: 'p.integration_client_id' },
	{ type: 'LEFT' as const, table: 'sms_shortcut_tokens', alias: 't', left: 't.phone_id', right: 'p.id', on: [{ column: 't.status', value: 'bound' }] },
];

const publicPhone = (row: Record<string, unknown>) => ({
	id: row.id, number: row.number, title: row.title || null, client_title: row.client_title ?? null, status: row.status,
	bound_at: Number(row.bound_at ?? 0) || null,
	revoked_at: Number(row.revoked_at ?? 0) || null,
	last_check_at: Number(row.last_check_at ?? 0) || null,
	last_message_at: Number(row.last_message_at ?? 0) || null,
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
		// 判「没取到值」而不是「有没有报错」：'0' 是合法取值（不挂项目），而后面要的是一个确定的字符串。
		if (!client.value) return apiMessage(c, 400, client.error ?? '选中的项目不存在，或者不属于你');
		/**
		 * 建手机、领令牌、取回下载地址走**共用实现**（`modules/sms/binding.mts`）：票据路径
		 * （§6.2）用的是同一段。各写一遍的话，「先领令牌再建手机」「重复绑定要幂等」这些
		 * 规则会在两处漂移，而漂移的表现是「从控制台绑好用、从接口绑不好用」。
		 *
		 * 写入走操作层：这一层在 `/api/panel/user/` 下，立即生效、照常留痕。
		 */
		const outcome = await bindPhone({
			database,
			globalDatabase: c.get('globalDatabase'),
			siteKey: c.get('site').siteKey,
			ownerUid: String(currentUser.id),
			clientId: client.value,
			number,
			title,
			runWrite: (statement) => runOperationSql(c, database, statement),
		});
		if (!outcome.ok) return apiMessage(c, outcome.status, outcome.message);
		const downloadUrl = outcome.downloadUrl;
		const bound = outcome.reissued ? '这个号码原来的快捷指令已经失效，给你换了一份新的（手机上旧的那份请删掉）'
			: outcome.alreadyBound ? '这个号码之前就绑过了' : `${number} 已绑定`;
		return apiMessageData(c, 200,
			downloadUrl
				? `${bound}。请在**手机上**打开下面的地址，下载并添加这个快捷指令：\n\n${downloadUrl}\n\n`
					// 快捷指令不会自己在收到短信时运行，这一步不做就一条都不转——而且没有任何报错。
					+ '添加之后**还要设一条自动化**，否则不会自动转发：打开「快捷指令」App →「自动化」→ 新建「信息」自动化，选「立即运行」，动作选这个快捷指令。'
					+ '设好之后手动运行一次，看到「测试成功」和你的号码就说明通了。\n\n'
					+ '地址 15 分钟内有效，过期了**再绑一次同一个号码**就会重新给你一个。'
				: `${bound}，但取回快捷指令文件失败——请联系管理员检查 sms-shortcut 用途的对象存储绑定。`,
			{ number, download_url: downloadUrl ?? null },
			{ component: 'modal', showIcon: true, title: outcome.reissued ? '已换发快捷指令' : outcome.alreadyBound ? '已经绑定过' : '绑定成功' });
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
		/**
		 * 会不会转发：与投递时的匹配**同一条规则**（modules/sms/push.mts）——同一个人、同一个
		 * 项目、启用中，限定了手机的只算那一部。两处规则不一致的话，这一列说「已配置」而
		 * 短信其实推不出去，比不提示还糟。
		 *
		 * 一次取回这个人的全部地址在应用层配对，不按行查：一个人的推送地址就那么几条。
		 */
		const endpoints = await allSql<{ integration_client_id: string; phone_id: string | null }>(database, sql({ database }).select({
			table: 'sms_push_endpoints',
			columns: { integration_client_id: { column: 'integration_client_id', cast: 'text' }, phone_id: { column: 'phone_id', cast: 'text' } },
			where: [ownerScope('owner_uid', currentUser.id), { column: 'status', value: 'enabled' }],
		}));
		const pushHint = (row: Record<string, unknown>) => (endpoints.some((endpoint) => String(endpoint.integration_client_id ?? '0') === String(row.integration_client_id ?? '0')
			&& (!endpoint.phone_id || String(endpoint.phone_id) === String(row.id))) ? 'configured' : 'none');
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
				] } }, { key: 'delete', label: '删除' }],
				row: [{ key: 'edit', label: '编辑' }],
			} },
			columns, dataSource: rows.map((row) => ({ ...publicPhone(row), push_hint: pushHint(row) })), totalRecords: rows.length,
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
		/**
		 * 删除之后，这部手机上的快捷指令**立即停用**：接收接口按令牌找手机，删掉的手机
		 * 查不到，回「手机记录已经不存在」。唯一索引带 `deleted_at`，所以同一个号码可以
		 * 马上重新绑定，拿到的是一份全新的快捷指令。
		 */
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_phones', [{ column: 'id', value: id }, mine()])));
		return apiMessage(c, 200, '已删除，这些手机上的快捷指令即刻停用。同一个号码可以重新绑定；删掉的记录可在回收站找回。');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
