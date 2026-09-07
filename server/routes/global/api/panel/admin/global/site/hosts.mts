import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { normalizeHostname } from '@server/modules/base/site-router.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

export const tableCrud: TableCrudDefinition = { table: 'global_site_hosts', rowKey: 'id' };
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { accountsIdentityApi } from '@server/modules/base/navigation.mjs';
import { allSql, firstSql, runSql, sql, type SqlQuery } from '@server/database/sql.mjs';
import { runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { DEFAULT_WEB_CLIENT, WEB_CLIENTS } from '@shared/web-clients.mjs';

/** 下拉选项直接从清单来，加一套前端只改清单那一处。 */
const WEB_CLIENT_OPTIONS = WEB_CLIENTS.map((client) => ({ value: client.key, text: client.label }));
const knownClientKey = (value: unknown) => {
	const key = String(value ?? '').trim();
	return WEB_CLIENTS.some((client) => client.key === key) ? key : '';
};

const columns = [
	{ dataIndex: 'id', title: 'ID' },
	{ dataIndex: 'hostname', title: '域名', component: 'textbox' },
	{ dataIndex: 'site_key', title: '站点', component: 'select', placeholder: '搜索并选择站点', rules: [{ required: true, message: '请选择站点' }] },
	/**
	 * 前端跟着**域名**走，不跟着站点：`m.example.com` 与 `www.example.com` 往往指向同一个
	 * 站点、同一批数据，只是 UI 不同。选项来自 `shared/web-clients.mts`——那份清单与
	 * esbuild 的构建入口一一对应，因此下拉里不会出现一个没构建出来的产物。
	 */
	{ dataIndex: 'client_key', title: '前端', component: 'select', options: WEB_CLIENT_OPTIONS, placeholder: `默认：${DEFAULT_WEB_CLIENT.label}` },
	{ dataIndex: 'status', title: '状态', component: 'switch', checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
];

const normalizeHostPattern = (value: unknown) => {
	const raw = String(value ?? '').trim();
	if (raw.startsWith('*.')) {
		const suffix = normalizeHostname(raw.slice(2));
		return suffix && !suffix.includes(':') ? `*.${suffix}` : '';
	}
	return normalizeHostname(raw);
};

const parseBody = async (c: Parameters<ApiHandler>[0]): Promise<Record<string, unknown>> => {
	try { return await c.req.json<Record<string, unknown>>(); }
	catch { return {}; }
};

/**
 * 删一个域名前要过两道检查，通过了返回那条待执行的语句。
 *
 * **检查与执行分开，是为了让批量删除能一次提交。** 一条一条 `runOperationSql` 的话，
 * 第一条就抛 `PendingApprovalError`（后台的写入要走审批），循环当场中断——选了五行，
 * 只有第一行进了队列，其余四行**静默丢失**，而界面回的是「已提交审批」。
 */
const hostDeletion = async (c: Parameters<ApiHandler>[0], id: number): Promise<{ error?: Response; statement?: SqlQuery }> => {
	const database = c.get('database');
	const host = await firstSql<{ hostname: string; status: string }>(database, sql({ database }).select({ table: 'global_site_hosts', columns: { hostname: 'hostname', status: 'status' }, where: [{ column: 'id', value: id }] }));
	if (!host) return {};
	if (host.status !== statusValues.disabled) return { error: await apiMessage(c, 409, '域名必须先停用才能删除') };
	const bot = await firstSql(database, sql({ database }).select({ table: 'global_telegram_bots', columns: { id: 'id' }, where: [{ column: 'webhook_hostname', value: host.hostname }], limit: 1 }));
	if (bot) return { error: await apiMessage(c, 409, '域名正在被 Telegram 机器人使用，不能删除') };
	return { statement: sql({ database }).softDelete('global_site_hosts', { id }) };
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	if (!params.id && c.req.method === 'GET') {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'global_site_hosts', columns: { id: 'id', hostname: 'hostname', site_key: 'site_key', client_key: 'client_key', status: 'status', created_at: 'created_at' }, sort: tableSort(c), orderBy: [{ column: 'id' }] }));
		const sites = await allSql<{ site_key: string; title: string }>(database, sql({ database }).select({ table: 'global_sites', columns: { site_key: 'key', title: 'title' }, where: [{ column: 'status', value: 'enabled' }, { column: 'migration_status', value: 'ready' }], orderBy: [{ column: 'key' }] }));
		const siteOptions = sites.map((site) => ({ value: site.site_key, text: `${site.title} (${site.site_key})` }));
		const tableColumns = columns.map((column) => column.dataIndex === 'site_key' ? { ...column, options: siteOptions } : column);
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }], row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }] } }, columns: tableColumns, dataSource: rows, totalRecords: rows.length } });
	}
	if (!params.id && c.req.method === 'POST') {
		const body = await parseBody(c);
		const hostname = normalizeHostPattern(body.hostname);
		const siteKey = String(body.site_key ?? '').trim();
		// 认不出的 key 一律存空串（= 默认那一套）：留着一个不存在的值，那个域名会去请求一个
		// 404 的脚本，页面停在加载动画上，而后台看着一切正常。
		const clientKey = knownClientKey(body.client_key);
		if (!hostname) return apiMessage(c, 400, 'Host 不合法');
		const site = await firstSql(database, sql({ database }).select({ table: 'global_sites', columns: { site_key: 'key' }, where: [{ column: 'key', value: siteKey }, { column: 'status', value: 'enabled' }, { column: 'migration_status', value: 'ready' }] }));
		if (!site) return apiMessage(c, 400, '站点不存在或尚未就绪');
		await runOperationSql(c, database, sql({ database }).insert('global_site_hosts', { hostname, site_key: siteKey, status: 'enabled' }));
		await c.get('siteRouter').refresh();
		return apiMessage(c, 201, '新增成功');
	}
	if (!params.id && c.req.method === 'DELETE') {
		const ids = await c.req.json<unknown[]>().catch(() => []);
		const statements: SqlQuery[] = [];
		for (const id of Array.isArray(ids) ? ids : []) {
			const result = await hostDeletion(c, Number(id));
			if (result.error) return result.error;
			if (result.statement) statements.push(result.statement);
		}
		await runOperation(c, database, statements);
		await c.get('siteRouter').refresh();
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'global_site_hosts', columns: { id: 'id', hostname: 'hostname', site_key: 'site_key', client_key: 'client_key', status: 'status', created_at: 'created_at' }, where: [{ column: 'id', value: Number(params.id) }] }));
		return row ? apiResponse(c, 200, row) : apiMessage(c, 404, 'Host 不存在');
	}
	if (params.id && c.req.method === 'PUT') {
		const current = await firstSql<{ hostname: string; site_key: string; status: string }>(database, sql({ database }).select({ table: 'global_site_hosts', columns: { hostname: 'hostname', site_key: 'site_key', status: 'status' }, where: [{ column: 'id', value: Number(params.id) }] }));
		if (!current) return apiMessage(c, 404, 'Host 不存在');
		const body = await parseBody(c);
		const changedFields = getChangedFields(body, ['hostname', 'site_key', 'client_key', 'status']);
		const hostname = changedFields.has('hostname') ? normalizeHostPattern(body.hostname) : null;
		if (changedFields.has('hostname') && !hostname) return apiMessage(c, 400, 'Host 不合法');
		const status = !changedFields.has('status') ? null : body.status === statusValues.disabled ? statusValues.disabled : body.status === statusValues.enabled ? statusValues.enabled : null;
		const nextSiteKey = changedFields.has('site_key') && typeof body.site_key === 'string' ? body.site_key.trim() : current.site_key;
		const site = await firstSql(database, sql({ database }).select({ table: 'global_sites', columns: { site_key: 'key' }, where: [{ column: 'key', value: nextSiteKey }, { column: 'status', value: 'enabled' }, { column: 'migration_status', value: 'ready' }] }));
		if (!site) return apiMessage(c, 400, '站点不存在或尚未就绪');
		const bot = await firstSql(database, sql({ database }).select({ table: 'global_telegram_bots', columns: { id: 'id' }, where: [{ column: 'webhook_hostname', value: current.hostname }], limit: 1 }));
		// 机器人回调域名只能留在身份中心站点上，否则 Telegram 的 webhook 会指向没有身份数据的站点。
		const accountsSiteKey = (await c.get('siteRouter').resolveByApi(accountsIdentityApi))?.siteKey;
		if (bot && ((hostname && hostname !== current.hostname) || nextSiteKey !== accountsSiteKey || status === statusValues.disabled)) {
			return apiMessage(c, 409, '域名正在被 Telegram 机器人使用，请先切换或停用相关机器人');
		}
		const values: Record<string, unknown> = {};
		if (hostname) values.hostname = hostname;
		if (changedFields.has('site_key')) values.site_key = nextSiteKey;
		if (changedFields.has('client_key')) values.client_key = knownClientKey(body.client_key);
		if (status) values.status = status;
		if (Object.keys(values).length) await runOperationSql(c, database, sql({ database }).update('global_site_hosts', values, { id: Number(params.id) }));
		await c.get('siteRouter').refresh();
		return apiMessage(c, 200, '保存成功');
	}
	if (params.id && c.req.method === 'DELETE') {
		const result = await hostDeletion(c, Number(params.id));
		if (result.error) return result.error;
		if (result.statement) await runOperationSql(c, database, result.statement);
		await c.get('siteRouter').refresh();
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
