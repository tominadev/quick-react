/**
 * 变更留痕的受管范围，见 docs/requirements/change-audit-and-revert.md。
 *
 * 这里是**代码常量而非配置**，与 SYSTEM_FIELD_NAMES 同例：放进数据库意味着
 * 运行时可以关掉审计，那正是审计最不该允许的事。
 */

/** 变更留痕覆盖的表：这些表上的业务字段变更会留下记录，并且可以撤回。 */
export const AUDITED_TABLES = [
	// base：租户、分站、域名绑定与账号本体，都是人管的主数据。
	'base_users', 'base_oidc_users', 'base_tenants', 'base_branches', 'base_hosts',
	'base_configs', 'base_bootstrap',
	// global：站点、域名与云凭据，改错一处影响整个部署。
	'global_sites', 'global_site_hosts', 'global_telegram_bots',
	'global_cloud_credentials',
	'global_cloud_email_channels', 'global_cloud_email_bindings',
	'global_cloud_email_templates', 'global_cloud_email_template_publications',
	'global_cloud_object_storage_buckets', 'global_cloud_object_storage_bindings',
	'global_cloud_object_storage_binding_purposes',
	// passport：身份本体、凭证与授权关系。角色和密码的变更最需要证据。
	'passport_users', 'passport_user_roles', 'passport_user_credentials',
	'passport_emails', 'passport_user_emails',
	'passport_external_providers', 'passport_external_identities',
	'passport_oauth_accounts', 'passport_oidc_clients',
	'passport_telegram_accounts', 'passport_telegram_menus', 'passport_group_prompts',
	// pve：资源编排的主数据，任务队列除外。
	'pve_regions', 'pve_nodes', 'pve_instance_flavors', 'pve_vms',
] as const;

/**
 * 显式声明不审计的表，与白名单共同覆盖全部表（见 §3.4 的覆盖性测试）。
 *
 * 三类：会话与设备等机器行为、协议瞬态（挑战、票据、授权码、状态机）、
 * 以及审计表自身——审计自己会无限递归，它靠不可修改与保留期保证完整性。
 */
export const UNAUDITED_TABLES = [
	// 审计表自身与迁移记账。
	'base_audit_entries', 'global_schema_migrations',
	// 会话、设备与快照：机器写入，量大且没有追责价值。
	'base_sessions', 'base_devices', 'base_device_users', 'base_device_snapshots',
	'passport_sessions', 'passport_site_sessions', 'passport_devices', 'passport_device_users',
	// 协议瞬态：登录挑战、票据、授权码、令牌、状态机，生命周期以分钟计。
	'base_oidc_sessions', 'base_oidc_login_requests',
	'passport_login_challenges', 'passport_login_tickets', 'passport_sso_requests',
	'passport_oidc_authorization_requests', 'passport_oidc_authorization_codes',
	'passport_oidc_access_tokens', 'passport_oidc_signing_keys',
	'passport_external_login_states', 'passport_external_pending_identities',
	'passport_external_pending_qr_states', 'passport_telegram_identity_choices',
	// 一次性验证码。
	'passport_email_otp', 'passport_user_email_otps', 'passport_external_email_otps',
	// 机器队列与内部状态。
	'passport_telegram_updates', 'passport_snowflake_state',
	'pve_vm_tasks',
] as const;

/**
 * 受管表里不算「变更」的列。
 *
 * 前几个是心跳时间戳，后两个是每次变更都会动的副产品而非变更内容。
 * 一次更新如果只碰了这些列，整条不产生记录，**且不读原行**——判断只看列名。
 */
export const NON_AUDITED_COLUMNS = [
	'last_seen_at', 'last_used_at', 'last_success_at', 'expires_at',
	'updated_at', 'updated_duid',
] as const;

/**
 * 值不对外显示的列：**照常记录、照常撤回，只是接口不返回它的前后值**。
 *
 * 撤回是服务端把记录里的值直接写回去，不经过接口，因此不需要任何人看见它。
 * 不做加密——解密密钥与数据库同机，能脱库的人一样拿得到（见需求文档 §5）。
 */
export const HIDDEN_VALUE_COLUMNS = [
	'password', 'dsn', 'dsn_password',
	'token', 'token_hash', 'secret_token', 'secret_hash',
	'access_key_secret', 'api_token_secret', 'client_secret',
	'authorization_code_hash', 'code_hash',
	// base_configs.value 整块 JSON 里混着 OIDC 客户端密钥，无法逐列区分。
	'value',
] as const;

const auditedTables: ReadonlySet<string> = new Set(AUDITED_TABLES);
const nonAuditedColumns: ReadonlySet<string> = new Set(NON_AUDITED_COLUMNS);
const hiddenValueColumns: ReadonlySet<string> = new Set(HIDDEN_VALUE_COLUMNS);

export const isAuditedTable = (table: string) => auditedTables.has(table);
export const isNonAuditedColumn = (column: string) => nonAuditedColumns.has(column);
export const isHiddenValueColumn = (column: string) => hiddenValueColumns.has(column);

/** 只碰排除列的更新在读原行之前就短路，心跳写入因此零成本。 */
export const hasAuditableColumns = (columns: readonly string[]) => columns.some((column) => !nonAuditedColumns.has(column));
