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
	'passport_telegram_accounts',
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
	// Telegram 的会话状态机与菜单状态：都是机器按对话进度改写的 UI/流程状态。
	'passport_telegram_menus', 'passport_group_prompts',
	// 一次性验证码。
	'passport_email_otp', 'passport_user_email_otps', 'passport_external_email_otps',
	// 机器队列与内部状态。
	'passport_telegram_updates', 'passport_snowflake_state',
	'pve_vm_tasks',
] as const;

/**
 * 每张受管表里**值得留证据的列**，逐表显式声明。
 *
 * 这里是白名单而不是排除清单：排除是失败在敞开的一侧——新增一个机器维护的列，
 * 它会静默地开始产生噪音，而且只有等表撑大了才会被发现。白名单反过来，
 * 新增列默认不记，再由 §3.4 的覆盖性测试逼着做一次显式决定。
 *
 * 没有列进来的都是机器维护的：心跳时间戳、上游快照、状态机、探活结果、
 * 派生的哈希与只读标志。它们不是人做的修改，记下来只有噪音没有证据价值。
 */
export const AUDITED_COLUMNS: Record<string, readonly string[]> = {
	// —— base ——
	base_users: ['name', 'password', 'roles', 'status', 'owner_uid'],
	base_tenants: ['key', 'name', 'status'],
	base_branches: ['key', 'name', 'status'],
	base_hosts: ['hostname', 'tenant_id', 'branch_id', 'status'],
	base_configs: ['key', 'value'],
	base_bootstrap: ['key', 'value'],
	// profile 是上游 ID Token claims 的快照，每次登录刷新，iat/exp/jti 都会变。
	base_oidc_users: ['issuer', 'subject', 'user_id'],

	// —— global ——
	// migration_status 是迁移状态机，is_system 是建库时定死的只读标志。
	global_sites: ['key', 'name', 'base_site_key', 'dsn', 'dsn_password', 'database_binding', 'status', 'is_default', 'passport_sso_enabled'],
	global_site_hosts: ['hostname', 'site_key', 'status'],
	global_telegram_bots: ['name', 'token', 'username', 'secret_token', 'webhook_hostname', 'status'],
	global_cloud_credentials: ['name', 'provider', 'account_id', 'access_key_id', 'access_key_secret', 'status'],
	global_cloud_email_channels: ['cloud_credential_id', 'region', 'account_name', 'from_alias', 'reply_to_address', 'status'],
	global_cloud_email_bindings: ['site_key', 'channel_id', 'template_id', 'purpose', 'is_default', 'status'],
	global_cloud_email_templates: ['key', 'type', 'name', 'subject', 'body_text', 'body_html', 'status'],
	// provider_template_id 与 content_hash 由发布流程算出来回填，不是人填的。
	global_cloud_email_template_publications: ['template_id', 'cloud_credential_id', 'region', 'status'],
	global_cloud_object_storage_buckets: ['cloud_credential_id', 'endpoint', 'region', 'bucket', 'path_style', 'public_base_url', 'extra_config', 'status'],
	global_cloud_object_storage_bindings: ['site_key', 'bucket_id', 'key_prefix', 'status'],
	global_cloud_object_storage_binding_purposes: ['binding_id', 'site_key', 'purpose', 'is_default'],

	// —— passport ——
	passport_users: ['user_id', 'name', 'nickname', 'status'],
	passport_user_roles: ['user_id', 'role'],
	passport_user_credentials: ['user_id', 'password'],
	passport_emails: ['email', 'verified'],
	passport_user_emails: ['user_id', 'email_id', 'is_primary'],
	passport_external_providers: ['provider', 'display_name', 'client_id', 'client_secret', 'status', 'wechat_mode', 'wechat_redirect_domain'],
	// profile 同 base_oidc_users：上游资料快照，每次登录刷新。
	passport_external_identities: ['user_id', 'provider', 'subject'],
	passport_oauth_accounts: ['user_id', 'provider', 'provider_user_id'],
	passport_oidc_clients: ['client_id', 'name', 'secret_hash', 'redirect_uris', 'allowed_scopes', 'require_pkce', 'status', 'backchannel_logout_uri', 'strict_redirect_uri'],
	// chat_id 与 nickname 由 webhook 按用户在 Telegram 侧的改名同步，不是本站操作。
	passport_telegram_accounts: ['user_id', 'bot_id', 'telegram_user_id'],

	// —— pve ——
	pve_regions: ['code', 'name', 'display_name', 'status', 'sort_order'],
	// last_checked_at 与 last_error 是探活结果。
	pve_nodes: ['region_id', 'name', 'host', 'port', 'cluster_name', 'api_user', 'api_token_id', 'api_token_secret', 'status'],
	pve_instance_flavors: ['code', 'name', 'cpu_cores', 'memory_gb', 'status', 'sort_order'],
	// pve_status / pve_config / error_message 是从 PVE 拉回来的运行时状态。
	pve_vms: ['kind', 'region_id', 'node_id', 'instance_flavor_id', 'name', 'status'],
};

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
const auditedColumns = new Map(Object.entries(AUDITED_COLUMNS).map(([table, columns]) => [table, new Set<string>(columns)]));
const hiddenValueColumns: ReadonlySet<string> = new Set(HIDDEN_VALUE_COLUMNS);

export const isAuditedTable = (table: string) => auditedTables.has(table);
export const isAuditedColumn = (table: string, column: string) => auditedColumns.get(table)?.has(column) ?? false;
export const isHiddenValueColumn = (column: string) => hiddenValueColumns.has(column);

/**
 * deleted_at 由公共层维护，因此不出现在任何一张表的白名单里，但它是软删除与恢复的
 * 唯一信号——受管表一律放行，否则「谁删了这一行」永远记不下来。
 */
const ALWAYS_AUDITED_COLUMN = 'deleted_at';

/** 白名单之外的列在读原行之前就短路：机器写入因此零成本。 */
export const auditableColumns = (table: string, columns: readonly string[]) => {
	const allowed = auditedColumns.get(table);
	return allowed ? columns.filter((column) => column === ALWAYS_AUDITED_COLUMN || allowed.has(column)) : [];
};
