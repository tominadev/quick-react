import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';
import { generatePlatformKey } from '@server/modules/sms/platform-key.mjs';

/**
 * 平台推送密钥。推送时用这里的私钥签名，接收方用 `/api/push-key` 取到的公钥验签。
 *
 * **私钥在服务端生成、明文入库、不在这一页显示。** 它只有一个用途——投递时签名，没有任何人
 * 需要看到它。这与接入方公钥那一侧正好相反：那边私钥属于接入方，本站只存公钥，生成也放在
 * 浏览器里做（见 client-keys.mts）。
 *
 * **轮换是这一页的主要动作**：点「生成新密钥」，新的一把成为 `active`、旧的转 `retiring`，
 * 两把公钥同时公布。已经发出去、正在重试的请求是用旧私钥签的，不继续公布旧公钥就会在接收方
 * 那边突然验不过——那不是攻击，表现却和攻击一模一样。观察一个完整的重试窗口之后再退役。
 */

const STATUS_OPTIONS = [
	{ value: 'active', text: '当前签名', color: 'green' },
	{ value: 'retiring', text: '退役中（仍公布）', color: 'gold' },
	{ value: 'retired', text: '已退役', color: 'default' },
];

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '生成时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'kid', title: '密钥标识', ellipsis: true },
	{ dataIndex: 'public_key', title: '公钥', ellipsis: true },
	{ dataIndex: 'status', title: '状态', options: STATUS_OPTIONS },
	{ dataIndex: 'retired_at', title: '退役时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '未退役' }];

export const tableCrud: TableCrudDefinition = { table: 'sms_platform_keys', rowKey: 'id' };

/** `private_key` 一列都不取：它没有任何理由离开服务端，连查询里都不该出现。 */
const listColumns = {
	id: { column: 'id', cast: 'text' as const }, created_at: 'created_at',
	kid: 'kid', public_key: 'public_key', status: 'status', retired_at: 'retired_at',
} as const;

const publicRow = (row: Record<string, unknown>) => ({
	id: row.id, created_at: row.created_at, kid: row.kid, public_key: row.public_key,
	status: row.status, retired_at: Number(row.retired_at ?? 0) || null,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: listColumns, sort: tableSort(c), orderBy: [{ column: 'id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				// 没有「新增」表单：密钥由服务端生成，没有任何一个字段该由人来填。
				toolbar: [{ key: 'generate', label: '生成新密钥', confirm: '生成一把新密钥并立即公布到 /api/push-key，但**先不用于签名**。等接收方的公钥缓存更新之后，再点这一行的「启用签名」。确认吗？' }],
				row: [
					{ key: 'activate', label: '启用签名', confirm: '从现在起用这把密钥签名，当前这把转为「退役中」（仍然公布）。确认前请确保接收方已经能在 /api/push-key 里看到它——否则他们会把新签名的推送当成伪造的丢掉。确认吗？', visibleWhen: { field: 'status', values: ['publishing'] } },
					{ key: 'retire', label: '退役', confirm: '退役之后这把公钥不再公布，用它签过、还在重试的请求会验不过。确认吗？', visibleWhen: { field: 'status', values: ['retiring'] } },
				],
			} },
			columns, dataSource: rows.map(publicRow), totalRecords: rows.length,
		} });
	}

	/**
	 * 生成一把新密钥，**只公布，不签名**。
	 *
	 * 轮换必须分两步：先发布到 `/api/push-key`，等接收方的公钥缓存更新，再启用签名。
	 * 接收方按公钥比对那份名单来判定来源（见 push-key.mts），而他们会缓存它——一步到位地
	 * 「生成即签名」的话，那一刻发出去的推送在接收方眼里就是一把没见过的公钥签的，直接被
	 * 当成伪造丢掉，而本站这边只看到一堆投递失败，看不出原因。
	 *
	 * 顺序由状态结构保证，不靠人记：新密钥落地就是 `publishing`，签名只认 `active`
	 * （见 platform-key.mts 的 loadSigningKey），**一把没被公布过的密钥不可能被用来签名**。
	 */
	if (!params.id && c.req.method === 'POST' && c.req.query('action') === 'generate') {
		const generated = await generatePlatformKey();
		const existing = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: { id: { column: 'id', cast: 'text' } }, where: [{ column: 'kid', value: generated.kid }], deleted: 'all', queued: 'all', limit: 1,
		}));
		// 32 字节随机撞上同一个 kid 的概率可以忽略，但真撞上时唯一索引会回一句裸的
		// UNIQUE 错误——那时候没人猜得到发生了什么。重来一次就好。
		if (existing) return apiMessage(c, 409, '生成的密钥与已有的一把撞了标识，请再点一次');
		await runOperation(c, database, [
			sql({ database }).insert('sms_platform_keys', { kid: generated.kid, public_key: generated.publicKey, private_key: generated.privateKey, status: 'publishing' }),
		]);
		return apiMessage(c, 201, `新密钥已生成并公布（${generated.kid}），但**还没用于签名**。等接收方能在 /api/push-key 里看到它之后，再点这一行的「启用签名」。`);
	}

	/**
	 * 启用签名：把一把**已经公布**的密钥切成当前签名那把。
	 *
	 * **先启新的、再把旧的转 retiring**，两条语句一次提交（同一个 operation_id，批准时一起
	 * 生效）。反过来的话中间会有一瞬间**一把 active 都没有**，那时候来的短信签不了名、投递
	 * 直接失败；而这个顺序的中间态是两把 active，签名取最新那把，不影响任何一次投递。
	 */
	if (params.id && c.req.method === 'POST' && c.req.query('action') === 'activate') {
		const row = await firstSql<{ id: string; kid: string; status: string }>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: { id: { column: 'id', cast: 'text' }, kid: 'kid', status: 'status' }, where: [{ column: 'id', value: params.id }],
		}));
		if (!row) return apiMessage(c, 404, '密钥不存在');
		// 只启用「公布中」的：已经在签名的再点一次没有意义，退役过的不能复活——两种都直说，
		// 而不是默默当成成功。
		if (row.status !== 'publishing') {
			return apiMessage(c, 409, row.status === 'active' ? '这把已经是当前签名用的密钥了' : '这把密钥已经不在公布中，不能启用；请生成一把新的');
		}
		const active = await allSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: { id: { column: 'id', cast: 'text' } }, where: [{ column: 'status', value: 'active' }],
		}));
		await runOperation(c, database, [
			sql({ database }).update('sms_platform_keys', { status: 'active' }, [{ column: 'id', value: params.id }, { column: 'status', value: 'publishing' }]),
			...active.map((item) => sql({ database }).update('sms_platform_keys', { status: 'retiring' }, [{ column: 'id', value: item.id }, { column: 'status', value: 'active' }])),
		]);
		return apiMessage(c, 200, active.length
			? `已启用签名（${row.kid}）。旧的那把转为「退役中」仍会公布，等过一个完整的投递重试窗口再退役它。`
			: `已启用签名（${row.kid}）。这是本站第一把签名密钥，推送从现在起可以发出去了。`);
	}
	if (params.id && c.req.method === 'POST' && c.req.query('action') === 'retire') {
		const row = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'id', value: params.id }],
		}));
		if (!row) return apiMessage(c, 404, '密钥不存在');
		// 只退役「退役中」的：当前签名那把退役了就没有密钥可签名，而这一页上没有任何提示
		// 会告诉人「你刚把推送整个关掉了」。
		if (row.status !== 'retiring') return apiMessage(c, 409, row.status === 'active' ? '这是当前签名用的密钥，先生成一把新的来替换它' : '这把密钥已经退役了');
		await runOperation(c, database, [sql({ database }).update('sms_platform_keys',
			{ status: 'retired', retired_at: Date.now() },
			[{ column: 'id', value: params.id }, { column: 'status', value: 'retiring' }])]);
		return apiMessage(c, 200, '已退役，这把公钥不再公布');
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_platform_keys', columns: listColumns, where: [{ column: 'id', value: params.id }],
		}));
		return row ? apiResponse(c, 200, publicRow(row)) : apiMessage(c, 404, '密钥不存在');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
