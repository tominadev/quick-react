import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 接入方的 Ed25519 公钥。**这里只存公钥。**
 *
 * 接入方用自己的私钥签发绑定票据，SMS 用登记的公钥验签（绑定文档 §7）。私钥始终留在接入方
 * 的服务端——**永远不写入本站的数据库、日志或接口响应**（§4.2）。
 *
 * 公钥那一栏带「在这台电脑上生成密钥对」：密钥对在**浏览器里**用 WebCrypto 生成，公钥自动
 * 填进表单，私钥只显示在那一个页面上供复制，**不上传**。服务端生成再发下来的话，私钥就经过
 * 了本站的代码路径，而「只有接入方持有私钥」正是这套签名的全部价值。不想用这个按钮的，
 * 占位符里写着 openssl 命令。
 *
 * **一个接入方多个公钥**，按 `kid` 定位：轮换期间新旧必须并存，一行放一个公钥做不到。
 * 流程是「先登记新 kid 置 active → 接入方切过去 → 把旧 kid 置 retired」，`retired` 的公钥
 * 立即拒绝新票据。协议只认 `kid`，没有 `key_version` 这个字段。
 *
 * `(integration_client_id, kid)` 上的唯一索引**不带 `deleted_at`**：一个用过的 kid 即便
 * 记录被删掉也不该能重新启用——那等于让一把退役的钥匙复活。
 */

const STATUS_OPTIONS = [
	{ value: 'active', text: '启用中', color: 'green' },
	{ value: 'retired', text: '已退役', color: 'default' },
];

/** Base64URL 的 32 字节：Ed25519 公钥的原始字节就是 32 字节，编码后 43 个字符（无补位）。 */
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '登记时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'integration_client_id', title: '接入方', component: 'select' as const, rules: [{ required: true, message: '请选择接入方' }], form: { edit: false as const } },
	{ dataIndex: 'kid', title: '密钥标识', component: 'textbox' as const, maxLength: 64,
		placeholder: '票据里的 kid，建议用启用日期，如 2026-09-01',
		// 改不得：票据里带的就是它，改掉等于让所有在途票据验不过。
		form: { edit: false as const },
		rules: [{ required: true, message: '请输入密钥标识' }] },
	{ dataIndex: 'public_key', title: '公钥', component: 'ed25519_public_key' as const,
		placeholder: 'Ed25519 公钥，Base64URL、43 个字符。点下面的按钮当场生成，或在接入方那台机器上用命令生成：\nopenssl genpkey -algorithm ed25519 -out private.pem\nopenssl pkey -in private.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d "="',
		form: { edit: false as const },
		rules: [{ required: true, message: '请粘贴公钥' }] },
	{ dataIndex: 'status', title: '状态', component: 'select' as const, options: STATUS_OPTIONS },
	{ dataIndex: 'retired_at', title: '退役时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '未退役', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_integration_client_keys', rowKey: 'id' };

const listColumns = {
	id: { column: 'k.id', cast: 'text' as const }, created_at: 'k.created_at',
	integration_client_id: { column: 'k.integration_client_id', cast: 'text' as const },
	client_name: 'c.name', client_title: 'c.title', kid: 'k.kid', public_key: 'k.public_key',
	status: 'k.status', retired_at: 'k.retired_at',
} as const;
const listJoins = [{ type: 'LEFT' as const, table: 'sms_integration_clients', alias: 'c', left: 'c.id', right: 'k.integration_client_id' }];

const publicKey = (row: Record<string, unknown>) => ({
	id: row.id,
	created_at: row.created_at,
	integration_client_id: String(row.integration_client_id ?? ''),
	// 名称与协议标识一起显示：前者认得出是谁，后者是票据里的 client_id，排查时要对的是它。
	client_name: row.client_name ? `${row.client_title ?? ''}（${row.client_name}）`.replace(/^（/, '') : null,
	kid: row.kid,
	public_key: row.public_key,
	status: row.status,
	retired_at: Number(row.retired_at ?? 0) || null,
});

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	const mine = (column = 'k.owner_uid') => ownerScope(column, currentUser.id);
	// 从接入方页面点进来时带着 integration_client_id：不筛的话弹开的是全站的公钥。
	const clientFilter = (c.req.query('integration_client_id') ?? '').trim();

	const clientOptions = async () => (await allSql<{ id: string; name: string; title: string }>(database, sql({ database }).select({
		table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' }, name: 'name', title: 'title' }, where: [ownerScope('owner_uid', currentUser.id)], orderBy: [{ column: 'id' }],
	}))).map((row) => ({ value: String(row.id), text: `${row.title}（${row.name}）` }));

	if (c.req.method === 'GET' && !params.id) {
		const [rows, options] = await Promise.all([
			allSql<Record<string, unknown>>(database, sql({ database }).select({
				table: 'sms_integration_client_keys', alias: 'k', columns: listColumns, joins: listJoins,
				where: clientFilter ? [{ column: 'k.integration_client_id', value: clientFilter }, mine()] : [mine()],
				sort: tableSort(c), orderBy: [{ column: 'k.id', direction: 'DESC' }],
			})),
			clientOptions(),
		]);
		/**
		 * 从接入方那一页点「公钥」进来时**已经知道是哪一家**，表单里就不该再问一遍。
		 *
		 * 那个值随弹窗的 `modalQueryFields` 进到嵌套表格的查询条件里，新增请求会把它一起
		 * 发出来（见 table_crud 的 selectedQuerySuffix），所以服务端照样收得到。
		 * 独立打开这一页时没有它，那时才需要在表单里选。
		 */
		const tableColumns = columns.map((column) => column.dataIndex !== 'integration_client_id'
			? column
			: clientFilter
				? { ...column, options, form: { create: false as const, edit: false as const } }
				: { ...column, options });
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'create', label: '登记公钥' }, { key: 'delete', label: '删除' }],
				row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }],
			} },
			columns: tableColumns, dataSource: rows.map(publicKey), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_integration_client_keys', alias: 'k', columns: listColumns, joins: listJoins, where: [{ column: 'k.id', value: params.id }, mine()],
		}));
		return row ? apiResponse(c, 200, publicKey(row)) : apiMessage(c, 404, '公钥不存在');
	}

	if (!params.id && c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		// 表单里没有这一列时（从接入方页面点进来的那种），值在查询条件里。
		const clientId = String(body.integration_client_id ?? '').trim() || clientFilter;
		const kid = String(body.kid ?? '').trim();
		// 粘贴时常带上换行与首尾空白，去掉再校验——否则「明明复制对了」却一直报格式错。
		const publicKeyValue = String(body.public_key ?? '').replace(/\s+/g, '');
		if (!clientId) return apiMessage(c, 400, '请选择接入方');
		if (!kid) return apiMessage(c, 400, '请输入密钥标识');
		if (!publicKeyPattern.test(publicKeyValue)) return apiMessage(c, 400, '公钥格式不对：应当是 Ed25519 原始字节的 Base64URL，43 个字符（不含补位的 =）');
		const client = await firstSql<{ id: string; name: string }>(database, sql({ database }).select({
			table: 'sms_integration_clients', columns: { id: { column: 'id', cast: 'text' }, name: 'name' }, where: [{ column: 'id', value: clientId }, ownerScope('owner_uid', currentUser.id)], limit: 1,
		}));
		if (!client) return apiMessage(c, 400, '接入方不存在，或者不属于你');
		// kid 重复要在**记录之前**挡掉：审批是先记录后应用，等撞唯一索引才失败的话，
		// 队列里已经留下一条谁也批不动的申请（同 users.mts 那一处）。
		const taken = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_integration_client_keys', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'integration_client_id', value: clientId }, { column: 'kid', value: kid }],
			deleted: 'all', queued: 'all', limit: 1,
		}));
		if (taken) return apiMessage(c, 409, '这个接入方下已经有同名的密钥标识了。kid 一旦用过就不再重复使用，换一个（例如换成今天的日期）。');
		try {
			await runOperationSql(c, database, sql({ database }).insert('sms_integration_client_keys', {
				integration_client_id: clientId, kid, public_key: publicKeyValue, status: String(body.status ?? 'active'),
			}));
			/**
			 * **把票据里要填的三个值一起报出来。**
			 *
			 * `client_id` 与 `base_user_id` 在别处都看不到——前者容易被当成「名称」，后者在
			 * 界面上根本没露过面。照着对接文档的示例值填是对接时最常踩的两脚，而两次都只会
			 * 得到一句笼统的拒绝。登记公钥恰好是写签名代码之前的最后一步，报在这里正好。
			 */
			return apiMessage(c, 201, [
				'公钥已登记。票据里这三个值照着填：',
				'',
				`  "client_id": "${client.name}"`,
				`  "kid": "${kid}"`,
				`  "base_user_id": "${currentUser.id}"`,
				'',
				'接入方切换到这个 kid 之后，记得把旧的那把改成「已退役」。',
			].join('\n'), { component: 'modal', showIcon: true, title: '公钥已登记' });
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '这个接入方下已经有同名的密钥标识了');
		}
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const row = await firstSql<{ id: string; status: string }>(database, sql({ database }).select({
			table: 'sms_integration_client_keys', columns: { id: { column: 'id', cast: 'text' }, status: 'status' }, where: [{ column: 'id', value: params.id }, ownerScope('owner_uid', currentUser.id)],
		}));
		if (!row) return apiMessage(c, 404, '公钥不存在');
		/**
		 * **只能改状态。** kid 与公钥本身改不得：票据里带的就是那个 kid，而公钥换掉等于
		 * 换了一把钥匙却沿用旧编号——所有在途票据会突然验不过，且事后无从分辨是被换了还是
		 * 真的伪造。要换钥匙就登记一个新 kid，这正是轮换流程。
		 */
		if (!getChangedFields(body, ['status']).has('status')) return apiMessage(c, 400, '这一页只能改状态；要换公钥请登记一个新的 kid');
		const status = String(body.status ?? '');
		if (!['active', 'retired'].includes(status)) return apiMessage(c, 400, '状态只能是「启用中」或「已退役」');
		if (status === row.status) return apiMessage(c, 400, '状态没有变化');
		await runOperation(c, database, [sql({ database }).update('sms_integration_client_keys',
			// 退役时间由服务端写：它是「什么时候停用的」这一事实，不是一个可填字段。
			{ status, retired_at: status === 'retired' ? Date.now() : null },
			[{ column: 'id', value: params.id }, { column: 'status', value: row.status }, ownerScope('owner_uid', currentUser.id)])]);
		return apiMessage(c, 200, status === 'retired' ? '已退役，用这个 kid 签的新票据会被拒绝' : '已启用');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的公钥');
		await runOperation(c, database, ids.map((id) => sql({ database }).softDelete('sms_integration_client_keys', [{ column: 'id', value: id }, ownerScope('owner_uid', currentUser.id)])));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;
