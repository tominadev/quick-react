import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { deleteTelegramWebhook, getTelegramBotIdentity, getTelegramWebhookInfo, setTelegramWebhook } from '@server/modules/global/telegram/api.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

export const tableCrud: TableCrudDefinition = { table: 'global_telegram_bots', rowKey: 'id' };
import { allSql, firstSql, runSql, sql } from '@server/database/sql.mjs';
import { runOperationSql } from '@server/modules/base/operation.mjs';
import { accountsIdentityApi } from '@server/modules/base/navigation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'updated_at', title: '更新时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss' },
	{ dataIndex: 'title', title: '名称', component: 'textbox', rules: [{ required: true, message: '请输入名称' }] },
	{ dataIndex: 'bot_token', title: 'Bot Token', component: 'textbox', inputType: 'password', hideInTable: true, placeholder: '留空表示保持原值', form: { create: { placeholder: '新增时必填', rules: [{ required: true, message: '请输入 Bot Token' }] } } },
	{ dataIndex: 'bot_username', title: 'Bot Username' },
	{ dataIndex: 'secret_token', title: 'Secret Token', component: 'textbox', inputType: 'password', hideInTable: true, placeholder: '留空表示保持原值', form: { create: { placeholder: '留空由系统生成' } } },
	{ dataIndex: 'webhook_hostname', title: 'Webhook 域名', component: 'select', placeholder: '选择 Passport 站点域名', rules: [{ required: true, message: '请选择 Webhook 域名' }] },
	{ dataIndex: 'status', title: '状态', component: 'switch', checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions }];

type BotRow = {
	id: number;
	title: string;
	bot_token: string;
	bot_username: string;
	secret_token: string;
	webhook_hostname: string;
	status: string;
	created_at: number;
	updated_at: number;
};

const parseBody = async (c: Parameters<ApiHandler>[0]): Promise<Record<string, unknown>> => c.req.json<Record<string, unknown>>().catch(() => ({}));
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const secretPattern = /^[A-Za-z0-9_-]{1,256}$/;
const createSecretToken = () => crypto.randomUUID().replaceAll('-', '');
const webhookUrl = (hostname: string, botId: number) => `https://${hostname}/api/tgwebhook?bot_id=${encodeURIComponent(String(botId))}`;

// 机器人回调必须落在身份中心站点的域名上；身份中心就是提供 Accounts 身份登录接口的站点。
const accountsSiteKey = async (c: Parameters<ApiHandler>[0]) => (await c.get('siteRouter').resolveByApi(accountsIdentityApi))?.siteKey;

const passportHostOptions = async (c: Parameters<ApiHandler>[0], database: DatabaseAdapter) => {
	const siteKey = await accountsSiteKey(c);
	if (!siteKey) return [];
	const rows = await allSql<{ hostname: string }>(database, sql({ database }).select({ table: 'global_site_hosts', columns: { hostname: 'hostname' }, where: [{ column: 'site_key', value: siteKey }, { column: 'status', value: 'enabled' }], sort: tableSort(c), orderBy: [{ column: 'hostname' }] }));
	return rows.map((row) => ({ value: row.hostname, text: row.hostname }));
};

const validatePassportHost = async (c: Parameters<ApiHandler>[0], database: DatabaseAdapter, hostname: string) => {
	const siteKey = await accountsSiteKey(c);
	return Boolean(siteKey && await firstSql(database, sql({ database }).select({ table: 'global_site_hosts', columns: { id: 'id' }, where: [{ column: 'hostname', value: hostname }, { column: 'site_key', value: siteKey }, { column: 'status', value: 'enabled' }] })));
};

const publicRow = (row: BotRow) => ({
	id: row.id,
	title: row.title,
	bot_username: row.bot_username,
	webhook_hostname: row.webhook_hostname,
	status: row.status,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

// Keep the API field names stable while reading the canonical short fields from the table.
const botColumns = {
	id: 'id',
	title: 'title',
	bot_token: 'token',
	bot_username: 'username',
	secret_token: 'secret_token',
	webhook_hostname: 'webhook_hostname',
	status: 'status',
	created_at: 'created_at',
	updated_at: 'updated_at',
};
const loadBot = (database: DatabaseAdapter, id: number) => firstSql<BotRow>(database, sql({ database }).select({ table: 'global_telegram_bots', columns: botColumns, where: [{ column: 'id', value: id }] }));
const botAssociated = async (database: DatabaseAdapter, id: number) => (await Promise.all([
	'passport_telegram_accounts', 'passport_telegram_email_otps', 'passport_telegram_menus', 'passport_telegram_identity_choices', 'passport_telegram_updates',
].map((table) => firstSql(database, sql({ database }).select({ table, columns: { bot_id: 'bot_id' }, where: [{ column: 'bot_id', value: id }], limit: 1 }))))).some(Boolean);
const duplicateBot = async (database: DatabaseAdapter, id: number, name: string, token: string, username: string) => (await Promise.all([
	// 列名是 title，不是 name（2026-08-29 改名时这里漏了）：查不存在的列会让 SQLite
	// 直接抛错，编辑机器人一路 500。
	['title', name], ['token', token], ['username', username],
].map(([column, value]) => firstSql(database, sql({ database }).select({ table: 'global_telegram_bots', columns: { id: 'id' }, where: [{ column, value }, { column: 'id', operator: '!=', value: id }], limit: 1 }))))).some(Boolean);

const removeBot = async (c: Parameters<ApiHandler>[0], id: number) => {
	const database = c.get('database');
	const bot = await loadBot(database, id);
	if (!bot) return undefined;
	if (bot.status !== statusValues.disabled) return apiMessage(c, 409, '机器人必须先停用才能删除');
	const passportDatabase = c.get('passportDatabase');
	if (!passportDatabase) return apiMessage(c, 503, 'Passport 数据库不可用，无法确认关联数据');
	const associated = await botAssociated(passportDatabase, id);
	if (associated) return apiMessage(c, 409, '机器人存在 Passport 账号关联，只能保持停用，不能删除');
	await runOperationSql(c, database, sql({ database }).softDelete('global_telegram_bots', { id }));
	return undefined;
};

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	if (!params.id && c.req.method === 'GET') {
		const [rows, hosts] = await Promise.all([
			allSql<BotRow>(database, sql({ database }).select({ table: 'global_telegram_bots', columns: botColumns, orderBy: [{ column: 'id', direction: 'DESC' }] })),
			passportHostOptions(c, database),
		]);
		const tableColumns = columns.map((column) => column.dataIndex === 'webhook_hostname' ? { ...column, options: hosts } : column);
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }], row: [{ key: 'test', label: 'Webhook 状态' }, { key: 'edit', label: '编辑' }, { key: 'delete', label: '删除', confirm: '机器人必须已停用且没有关联数据，确认删除吗？' }] } }, columns: tableColumns, dataSource: rows.map(publicRow), totalRecords: rows.length } });
	}
	if (!params.id && c.req.method === 'POST') {
		const body = await parseBody(c);
		// 表单发的是 title：列表、新增、编辑共用同一份 columns（dataIndex 为 title），
		// 编辑分支读的也是 body.title。这里漏改成 name，从后台新增必然报「名称不合法」。
		const name = text(body.title), token = text(body.bot_token), hostname = text(body.webhook_hostname);
		const secretToken = text(body.secret_token) || createSecretToken();
		const status = body.status === statusValues.disabled ? statusValues.disabled : statusValues.enabled;
		if (!name || !token || !secretPattern.test(secretToken) || !await validatePassportHost(c, database, hostname)) return apiMessage(c, 400, '名称、Bot Token、Secret Token 或 Passport 域名不合法');
		let identity;
		try { identity = await getTelegramBotIdentity(token); }
		catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Bot Token 校验失败'); }
		await runOperationSql(c, database, sql({ database }).insert('global_telegram_bots', { title: name, token, username: identity.username, secret_token: secretToken, webhook_hostname: hostname, status }), { conflict: '机器人名称、Token 或 Username 已存在' });
		const created = await firstSql<{ id: number }>(database, sql({ database }).select({ table: 'global_telegram_bots', columns: { id: 'id' }, where: [{ column: 'token', value: token }] }));
		if (!created) return apiMessage(c, 500, '机器人创建后无法读取');
		if (status === statusValues.enabled) {
			try { await setTelegramWebhook(token, webhookUrl(hostname, created.id), secretToken); }
			catch (error) {
				await runSql(database, sql({ database }).delete('global_telegram_bots', { id: created.id }));
				return apiMessage(c, 502, error instanceof Error ? error.message : 'Webhook 设置失败');
			}
		}
		return apiMessageData(c, 201, status === statusValues.enabled ? '机器人已创建并设置 Webhook' : '机器人已创建并保持停用', { id: String(created.id), bot_username: identity.username });
	}
	if (!params.id && c.req.method === 'DELETE') {
		const ids = await c.req.json<unknown>().catch(() => []);
		for (const value of Array.isArray(ids) ? ids : []) {
			const response = await removeBot(c, Number(value));
			if (response) return response;
		}
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id <= 0) return apiMessage(c, 400, '机器人 ID 不合法');
	if (c.req.method === 'GET') {
		const bot = await loadBot(database, id);
		return bot ? apiResponse(c, 200, publicRow(bot)) : apiMessage(c, 404, '机器人不存在');
	}
	if (c.req.method === 'POST' && c.req.query('action') === 'test') {
		const bot = await loadBot(database, id);
		if (!bot) return apiMessage(c, 404, '机器人不存在');
		try {
			const info = await getTelegramWebhookInfo(bot.bot_token);
			const lastError = info.lastErrorMessage ? `；最近错误：${info.lastErrorMessage}` : '';
			return apiMessageData(c, 200, `Webhook：${info.url || '未设置'}；待处理更新：${info.pendingUpdateCount}${lastError}`, { webhook: info }, { component: 'modal', title: 'Telegram Webhook 状态' });
		} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Webhook 状态查询失败'); }
	}
	if (c.req.method === 'PUT') {
		const current = await loadBot(database, id);
		if (!current) return apiMessage(c, 404, '机器人不存在');
		const body = await parseBody(c);
		const changed = getChangedFields(body, ['title', 'bot_token', 'secret_token', 'webhook_hostname', 'status']);
		const name = changed.has('title') ? text(body.title) : current.title;
		const token = changed.has('bot_token') && text(body.bot_token) ? text(body.bot_token) : current.bot_token;
		const secretToken = changed.has('secret_token') && text(body.secret_token) ? text(body.secret_token) : current.secret_token;
		const hostname = changed.has('webhook_hostname') ? text(body.webhook_hostname) : current.webhook_hostname;
		const status = changed.has('status') ? body.status === statusValues.disabled ? statusValues.disabled : statusValues.enabled : current.status;
		if (!name || !secretPattern.test(secretToken) || !await validatePassportHost(c, database, hostname)) return apiMessage(c, 400, '名称、Secret Token 或 Passport 域名不合法');
		let username = current.bot_username;
		if (token !== current.bot_token) {
			try { username = (await getTelegramBotIdentity(token)).username; }
			catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Bot Token 校验失败'); }
		}
		const duplicate = await duplicateBot(database, id, name, token, username);
		if (duplicate) return apiMessage(c, 409, '机器人名称、Token 或 Username 已存在');
		try {
			if (status === statusValues.enabled) await setTelegramWebhook(token, webhookUrl(hostname, id), secretToken);
			else if (current.status === statusValues.enabled || token !== current.bot_token) await deleteTelegramWebhook(current.bot_token);
			if (token !== current.bot_token && current.status === statusValues.enabled) await deleteTelegramWebhook(current.bot_token).catch(() => undefined);
		} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : 'Webhook 更新失败'); }
		await runOperationSql(c, database, sql({ database }).update('global_telegram_bots', { title: name, token, username, secret_token: secretToken, webhook_hostname: hostname, status }, { id }));
		return apiMessage(c, 200, status === statusValues.enabled ? '机器人已保存并更新 Webhook' : '机器人已停用并删除 Webhook');
	}
	if (c.req.method === 'DELETE') {
		const response = await removeBot(c, id);
		return response ?? apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;
