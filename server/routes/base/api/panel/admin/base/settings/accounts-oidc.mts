import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage } from '@server/modules/base/api-response.mjs';
import { settingsPageHandler } from '@server/modules/base/settings-page.mjs';
import { accountsOidcConfigKey, defaultAccountsOidcConfig, loadDiscovery, normalizeAccountsOidcConfig, oidcFetch, type AccountsOidcClientConfig } from '@server/modules/passport/accounts/client.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';
import { allSql, sql } from '@server/database/sql.mjs';
import { accountsIdentityApi } from '@server/modules/base/navigation.mjs';

const defaultIssuer = 'https://accounts.example.com';
const createFormPage = (issuerOptions: Array<{ value: string; text: string; fieldValues?: Record<string, unknown> }>): FormPageConfig => ({
	description: '业务站点通过 OIDC Authorization Code + PKCE 登录 Accounts。客户端密钥保存在本站数据库，不会写入全局站点库。',
	confirmOnUnchangedSubmit: '当前未修改，仍要提交吗？',
	confirmChangedSubmit: '将保存以下修改，确认继续吗？',
	submitLabel: '保存配置', actions: [{ key: 'test', label: '测试配置' }, { key: 'restore-defaults', label: '重置默认', confirm: '确认重置 Accounts OIDC 设置的默认值吗？重置后需要点击“保存配置”才会生效。' }], defaultValues: { ...defaultAccountsOidcConfig, issuerSource: '__custom__' }, initialValues: defaultAccountsOidcConfig,
	fields: [
		{ name: 'enabled', label: '启用 Accounts 登录', type: 'switch', defaultValue: false },
		{ name: 'issuerSource', label: 'Passport 域名', type: 'select', options: issuerOptions, placeholder: '选择 Passport 域名，或选择自定义', rules: [{ required: true, message: '请选择 Passport 域名来源' }] },
		{ name: 'issuer', label: 'Accounts Issuer', type: 'text', placeholder: 'https://accounts.example.com', readOnlyWhen: { field: 'issuerSource', optionValues: true }, rules: [{ required: true, message: '请输入 Accounts Issuer' }] },
		{ name: 'clientId', label: '客户端 ID', type: 'text', rules: [{ required: true, message: '请输入客户端 ID' }] },
		{ name: 'clientSecret', label: '客户端密钥', type: 'password', extra: '留空表示保留现有密钥；创建或重置 OIDC 客户端后只显示一次。' },
	],
});

type IssuerOption = { value: string; text: string; fieldValues?: Record<string, unknown> };

const loadIssuerOptions = async (c: Parameters<ApiHandler>[0], currentIssuer: string) => {
	const database = c.get('globalDatabase');
	const accountsSite = await c.get('siteRouter').resolveByApi(accountsIdentityApi);
	const rows = accountsSite ? await allSql<{ hostname: string }>(database, sql({ database }).select({
		table: 'global_site_hosts', alias: 'h',
		columns: { hostname: 'h.hostname' },
		joins: [{ table: 'global_sites', alias: 's', left: 's.key', right: 'h.site_key' }],
		where: [{ column: 'h.site_key', value: accountsSite.siteKey }, { column: 'h.status', value: 'enabled' }, { column: 's.status', value: 'enabled' }, { column: 's.migration_status', value: 'ready' }],
		orderBy: [{ column: 'h.hostname' }],
	})) : [];
	const options: IssuerOption[] = rows.filter((row) => !row.hostname.startsWith('*.')).map((row) => ({ value: `https://${row.hostname}`, text: `Passport (${row.hostname})`, fieldValues: { issuer: `https://${row.hostname}` } }));
	if (!options.length && !currentIssuer) options.push({ value: defaultIssuer, text: defaultIssuer, fieldValues: { issuer: defaultIssuer } });
	options.push({ value: '__custom__', text: '自定义 Issuer' });
	return options;
};

/**
 * Issuer 列表要查全局库，而一次请求里表单和回显值都要用它。按请求缓存，
 * 别为同一份下拉选项查两遍。
 */
const issuerOptionsCache = new WeakMap<object, Promise<IssuerOption[]>>();
const issuerOptions = (c: Parameters<ApiHandler>[0], currentIssuer: string) => {
	let options = issuerOptionsCache.get(c);
	if (!options) { options = loadIssuerOptions(c, currentIssuer); issuerOptionsCache.set(c, options); }
	return options;
};

/** 选中的是列表里的某个 Passport 域名，还是「自定义」。 */
const presentConfig = async (c: Parameters<ApiHandler>[0], config: AccountsOidcClientConfig) => {
	const options = await issuerOptions(c, config.issuer);
	// 客户端密钥不回显：它只在创建或重置 OIDC 客户端时显示一次。
	return { ...config, issuerSource: options.some((option) => option.value === config.issuer) ? config.issuer : '__custom__', clientSecret: '' };
};

export default settingsPageHandler({
	key: accountsOidcConfigKey,
	load: async (c) => normalizeAccountsOidcConfig(await c.get('configStore').get(accountsOidcConfigKey)),
	formPage: async (c, current) => ({ ...createFormPage(await issuerOptions(c, current.issuer)), initialValues: await presentConfig(c, current) }),
	present: presentConfig,
	parse: (c, body, current) => {
		const restoringDefaults = body.restoreDefaults === true;
		const config = normalizeAccountsOidcConfig(restoringDefaults ? { ...body, clientSecret: '' } : body, restoringDefaults ? defaultAccountsOidcConfig : current);
		if (config.enabled && (!config.issuer || !config.clientId || !config.clientSecret)) return '启用 Accounts 登录前必须填写有效 Issuer、客户端 ID 和客户端密钥';
		return config;
	},
	saved: 'Accounts OIDC 配置已保存',
	// 「测试配置」只连一次 Accounts，不写任何东西，因此不走审批。
	action: async (c, current) => {
		if (c.req.method !== 'POST' || c.req.query('action') !== 'test') return undefined;
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const config = normalizeAccountsOidcConfig(body, current);
		if (!config.issuer || !config.clientId || !config.clientSecret) return apiMessage(c, 400, '测试前必须填写 Issuer、客户端 ID 和客户端密钥');
		try {
			const discovery = await loadDiscovery(c, config.issuer);
			const jwksResponse = await oidcFetch(c, discovery.jwks_uri, { headers: { accept: 'application/json' } });
			if (!jwksResponse.ok) return apiMessage(c, 502, `Accounts JWKS 请求失败（HTTP ${jwksResponse.status}）`);
			const jwks = await jwksResponse.json() as { keys?: unknown[] };
			if (!Array.isArray(jwks.keys) || !jwks.keys.length) return apiMessage(c, 502, 'Accounts JWKS 中没有可用公钥');
			return apiMessage(c, 200, 'Accounts OIDC 连接测试通过：Issuer 发现文档和 JWKS 可用；客户端 ID、密钥及回调地址将在实际登录时验证');
		} catch (error) {
			return apiMessage(c, 502, error instanceof Error ? error.message : 'Accounts OIDC 配置测试失败');
		}
	},
});
