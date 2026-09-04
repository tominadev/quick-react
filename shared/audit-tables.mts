/**
 * 变更留痕的受管范围，见 docs/requirements/change-audit-and-revert.md。
 *
 * 这里是**代码常量而非配置**，与 SYSTEM_FIELD_NAMES 同例：放进数据库意味着
 * 运行时可以关掉审计，那正是审计最不该允许的事。
 */

/**
 * 审计自身不被审计，否则记录一条变更会再产生一条变更。**这是唯一的表级例外**，
 * 理由是防递归，不是防噪音。
 *
 * 「这次写入算不算人工操作」不在这里判断——那个信息在路由层才完整，
 * 由 runOperation 显式声明（见需求文档 §3.0）。表名和列名都分不出人和机器：
 * 同一个 passport_devices，登录时机器写是噪音，管理员吊销设备时人工写是证据。
 */
export const SELF_EXCLUDED_TABLES = ['base_audit_entries'] as const;

/**
 * 只读表：任何通用写入通道都不许碰。
 *
 * 审计表的自身排除本来只是**防递归**，但它顺带成了一条绕过通道——没有审计元信息，
 * runSql 的看门人不拦，审批也不管，于是「数据管理」这类直接操作原始表的页面
 * 可以随手改写审计记录。**审计能被随手改，就等于没有审计**（§7.3）。
 *
 * 它只能由审计模块自己写：记录变更、以及在状态迁移时改 status 与那几组操作者字段。
 */
export const WRITE_PROTECTED_TABLES = ['base_audit_entries'] as const;
const writeProtectedTables: ReadonlySet<string> = new Set(WRITE_PROTECTED_TABLES);
export const isWriteProtectedTable = (table: string) => writeProtectedTables.has(table);

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

const selfExcludedTables: ReadonlySet<string> = new Set(SELF_EXCLUDED_TABLES);
const hiddenValueColumns: ReadonlySet<string> = new Set(HIDDEN_VALUE_COLUMNS);

export const isSelfExcludedTable = (table: string) => selfExcludedTables.has(table);
export const isHiddenValueColumn = (column: string) => hiddenValueColumns.has(column);
