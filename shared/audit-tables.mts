/**
 * 变更留痕的受管范围，见 docs/requirements/change-audit-and-revert.md。
 *
 * 这里是**代码常量而非配置**，与 SYSTEM_FIELD_NAMES 同例：放进数据库意味着
 * 运行时可以关掉审计，那正是审计最不该允许的事。
 */

/**
 * 「这次写入算不算人工操作」不在这里判断——那个信息在路由层才完整，
 * 由 runOperation 显式声明（见需求文档 §3.0）。表名和列名都分不出人和机器：
 * 同一个 passport_devices，登录时机器写是噪音，管理员吊销设备时人工写是证据。
 *
 * **审计表自己也不例外。** 它不需要被排除在外：审计模块自身的写入走 runSystemSql，
 * 本来就不留痕，递归是被那条路径挡住的。因此从「数据管理」改一条审计记录会照常
 * 留痕、照常走审批——留下的那条新记录就是「谁动了审计」的证据。改一条记录必然
 * 产生一条新记录，想抹干净就得无限抹下去，篡改因此总是可见的。
 */

/**
 * 值不对外显示的列：**照常记录、照常回滚，只是接口不返回它的前后值**。
 *
 * 回滚是服务端把记录里的值直接写回去，不经过接口，因此不需要任何人看见它。
 * 不做加密——解密密钥与数据库同机，能脱库的人一样拿得到（见需求文档 §5）。
 */
export const HIDDEN_VALUE_COLUMNS = [
	'password', 'credential', 'dsn', 'dsn_password',
	'token', 'token_hash', 'secret_token', 'secret_hash',
	'access_key_secret', 'api_token_secret', 'client_secret',
	'authorization_code_hash', 'code_hash',
] as const;

const hiddenValueColumns: ReadonlySet<string> = new Set(HIDDEN_VALUE_COLUMNS);

export const isHiddenValueColumn = (column: string) => hiddenValueColumns.has(column);

/**
 * JSON 值里的键该不该隐藏。
 *
 * 列名有限、可以逐个列举；JSON 里的键是各处配置自己定的，列不全。因此除了同名列的
 * 那份名单，再加一条按名字判断的兜底——`clientSecret` 这种驼峰写法先折成下划线，
 * 名字里带 secret / password / token / credential 的一律当敏感处理。
 *
 * 宁可多藏也不少藏：藏错了只是看不到一个无关紧要的值，漏藏就是把密钥写进了可见页面。
 */
const secretNamePattern = /(^|_)(secret|secrets|password|token|credential|credentials|private)(_|$)/;
export const isHiddenValueKey = (key: string) => {
	const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
	return hiddenValueColumns.has(normalized) || secretNamePattern.test(normalized);
};
