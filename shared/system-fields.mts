/**
 * Columns owned by the common data layer.
 *
 * They are exposed for display and auditing, but are never business-form
 * inputs. The SQL layer supplies or maintains them automatically.
 *
 * `key` 只在**新建**时可以由调用方给（`global_sites` 这类表的 key 是人给的短串），
 * 之后一律不可改——它能被别的表引用，正是因为建后不动；改一次就把所有引用指向了空处。
 * 因此更新路径把它当系统字段挡掉，新建路径显式放行。
 */
export const SYSTEM_FIELD_NAMES = ['id', 'key', 'created_at', 'updated_at', 'deleted_at', 'queued_at', 'created_duid', 'updated_duid'] as const;
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number];
export const isSystemField = (name: string): name is SystemFieldName => (SYSTEM_FIELD_NAMES as readonly string[]).includes(name);

/**
 * 这张表的**名字列**叫什么。
 *
 * 「名字列」装的是**人给的、可重用的标识**——人取的、可以改的、租户内唯一的、不被别的表
 * 引用的那一列。它的唯一索引形态固定为 `(owner_tid, <名字列>, deleted_at)`，而
 * **`deleted_at` 正是它区别于其他唯一键的地方**：名字是人取的，软删一行之后同一个名字该能
 * 再用（解绑一个手机号之后要能重新绑回来）。其余唯一键（哈希、令牌摘要、nonce、对象键）
 * 一概不带 `deleted_at`，不带反而更安全。
 *
 * 默认叫 `name`。个别表里 `name` 读不出它装的是什么——`sms_phones.name` 存的是手机号，
 * 读的人得愣一下——可以换一个更具体的词，**但必须登记在这里**。
 *
 * 为什么要登记而不是随便取：「名字列参与的唯一索引才带 deleted_at」这条规则靠列名机械判断，
 * `test:naming` 就是这么守的。不登记就等于规则漏掉了这张表，而漏掉的后果不是报错，是那个
 * 手机号被永久占住、解绑之后再也绑不回来——一个要等到线上才发现的 bug。
 *
 * 登记是个显式动作，因此规则不会漂：今天加 `number`，明天有人想用 `code`，得先在这里写一行。
 */
/**
 * `sms_phones` 曾经登记过 `number`，因为手机号一度是这张表唯一性的落点：同一账号 + 项目下
 * 只能绑一次，解绑之后同一个号能重新绑回来。
 *
 * **现在改成允许同一个号码在同一接入方名下重复绑定**（接入方自己控制去重，用的是这张表的
 * `key`——SMS 绑定文档 §4.3、票据文档 §7 有详细说明；`key` 允许接入方指定值，是本项目里
 * 除 `global_sites` 之外唯一一处偏离"key 只装机器写的雪花号"的例外，登记在那两份文档而不是
 * 这里，因为这份文件只管"名字列"这一件事，不管 key 例外）。`number` 因此不再满足名字列的
 * 定义——它不再租户内唯一，重复是设计如此，不是遗漏——所以从这张登记表里删掉，
 * `test:naming` 也就不再要求它带 `(owner_tid, number, deleted_at)` 那条唯一索引。
 */
export const NAME_COLUMNS: Record<string, string> = {
	// 源站按采集端上报的 host 认人：它是主人配的、租户内唯一、删掉之后同一台机器该能再建。
	loki_sources: 'host',
};

/** 这张表的名字列；没登记过的就是 `name`。 */
export const nameColumnOf = (table: string) => NAME_COLUMNS[table] ?? 'name';

/**
 * 以 `_id` / `_key` 结尾、但**既不指向任何表、也不用来查询**的列。
 *
 * 这两个后缀在本项目里意味着「引用」，因此凡是这么结尾的列都要求有索引（没索引的外键
 * 意味着全表扫）。极少数列长得像引用却不是：`public_key` 是 Ed25519 公钥，是数据本身，
 * 谁也不会拿一段公钥去查表。
 *
 * 登记而不是放宽规则：放宽了就等于所有 `_key` 列都不必有索引，而绝大多数是真外键。
 * 写成 `<表>.<列>` 是为了精确到那一列——别的表如果也叫 public_key 而它确实是引用，规则照旧管它。
 */
export const NON_REFERENCE_COLUMNS = new Set([
	'sms_integration_client_keys.public_key',
	// 平台自己的推送签名密钥对：公钥要发给接收方，私钥只在签名时读。两者都是数据本身，
	// 没有任何查询会拿一段密钥去找行——真要按密钥找，那也说明它被当成凭证在用了。
	'sms_platform_keys.public_key',
	'sms_platform_keys.private_key',
	// 这个域名用哪一套前端。它引用的是**代码里的清单**（shared/web-clients.mts），不是
	// 另一张表——加索引没有对象可指。同一行上的 site_key 才是真外键，那个有索引。
	'global_site_hosts.client_key',
]);
